# GPU CBT (Dupuy 2021, WebGPU)

The full CBT — tree maintenance **and** meshing — runs on the GPU: a bit-packed
concurrent binary tree in a storage buffer, compute passes for the adaptive
forced-diamond split/merge + sum-reduction, and an **implicit mesh** (instanced
draw whose vertex shader decodes the heap). No CPU geometry, no per-frame upload;
main-thread cost ≈ 0. Selected by the `GPU_CBT` flag in
[setup_lod_and_shadows.ts](../../../../src/app/setup_lod_and_shadows.ts) (default
**true**); WebGPU-only — on WebGL2 it falls back to the worker/sync path. When
active it supersedes `offThreadCbt` (ref 12).

This is the faithful Dupuy scheme (vs the worker path, which is ROAM on the CPU).

## Files

- WGSL ([src/assets/shaders/cbt/gpu/](../../../../src/assets/shaders/cbt/gpu/)):
  `cbt_heap_rw.wgsl` (atomic heap core), `cbt_heap_ro.wgsl` (read-only heap for the
  vertex shader), `cbt_leb.wgsl` (octahedron LEB decode), `cbt_conform.wgsl`
  (forced-diamond split/merge + cross-face neighbor), `cbt_noise.wgsl` (WGSL port of
  the simplex/FBM field), `cbt_update.compute.wgsl` (metric + split/merge),
  `cbt_sum_reduction.compute.wgsl`.
- TS ([src/systems/lod/cbt/gpu/](../../../../src/systems/lod/cbt/gpu/)):
  `gpu_cbt_kernel.ts` (owns the storage buffer + compute passes + readback),
  `gpu_cbt_source.ts` (`CbtGeometrySource`, owns mesh+material, drives the kernel),
  `gpu_cbt_render_material.ts` (implicit-mesh WGSL ShaderMaterial),
  `gpu_cbt_buffers.ts` (`CbtCpuHeap` mirror for the seed + tests),
  `gpu_cbt_octahedron.ts` (CPU reference for the face mapping).
- Branched in [cbt_scheduler.ts](../../../../src/systems/lod/cbt/cbt_scheduler.ts)
  `createSource()` (`opts.gpuCbt && engine.isWebGPU` → `GpuCbtSource`).

## Heap layout (bit-packed, exact Dupuy)

Perfect binary tree of depth `D = CBT_MAX_DEPTH`. A node `(id, depth)` stores its
subtree **leaf count** in `(D − depth + 1)` bits at
`bitID = 2^(depth+1) + id·(D − depth + 1)` (proven non-overlapping). The deepest
level (`depth == D`) is a 1-bit-per-node leaf bitfield. A subdivision leaf at depth
`d` is **one** set bit — its leftmost depth-D descendant — so an internal node's
value == number of leaves below it. `cbt_decode(handle)` descends while value > 1,
recovering the leaf's true depth. Buffer ≈ `2^(D+2)` bits.

Reconciled bit-for-bit with libcbt:
- `cbt_SplitNode(node)` = set the **right child**'s leaf bit
  (`cbt__NodeBitID_BitField = NodeBitID(CeilNode(node))` = leftmost depth-D
  descendant). Same as our `cbt_setBit(cbt_bfIndex((id<<1)|1, depth+1), 1)`.
- `cbt_MergeNode(node)` = clear the **right sibling** bit `(id | 1)` — works from
  either child, idempotent.
- `cbt_DecodeNode` / `cbt_NodeCount` are count-based (bit positions don't matter for
  decode, only the per-node sums), so split/merge stay race-free.

Writes use `atomicAnd`/`atomicOr` with per-node-disjoint masks, so adjacent nodes
sharing a u32 word never corrupt each other regardless of thread interleaving.

## Octahedron + LEB convention (the subtle part)

The base mesh is the 8-face octahedron from `cbt_state.ts` (`ROOT_ALR`). The 8 faces
are the **depth-3 heap nodes** (ids 8..15); within a face the local LEB tree adds
`depth − 3` bits below the 3 face-selector bits (`cbt_localToFull` / `faceOf`).

**Decode and neighbor MUST share Dupuy's split convention** (`leb__SplittingMatrix`):
the bisected edge is `(v0, v2)`, the apex is the **middle** vertex `v1`,
`child0 = (v0, M, v1)`, `child1 = (v1, M, v2)`, `M = mid(v0, v2)`. `leb_decode` feeds
each face as `(v0 = L, v1 = pole, v2 = R)` so the first bisection splits the
equatorial hypotenuse. (Originally `leb_decode` bisected `(L,R)` with apex `v0` — a
*different* edge — which silently mismatched the neighbor bit-math and left ~6% of
edges as T-junctions. This convention alignment was the key fix.)

## Conformity — watertight everywhere

Forced-diamond, ported from libleb, **no heap reads** (pure id + geometry math), so
a batch of conforming splits applied to one stale snapshot then reduced once stays
consistent — exactly how the GPU pass works.

- **Same-depth edge neighbor**: `cbt_edgeNeighborLocal` = Dupuy
  `leb_DecodeSameDepthNeighborIDs` / `leb__SplitNodeIDs` (`.edge` field). Returns 0
  on a face boundary.
- **Conforming split** (`cbt_splitConforming`): bisect the node, then walk the
  longest-edge compatibility chain (split node + parent at each step) up to the root.
- **Cross-face (12 octahedron seams)**: when `edgeNeighborLocal` returns 0, the
  split edge is a seam. `cbt_crossEdge` finds the neighbor geometrically: decode the
  split edge `(P,Q)`, find the adjacent face (`cbt_adjacentFace` — the seam lies in a
  coordinate plane, the midpoint's other two coord signs pick the two axis vertices),
  then `cbt_encodeByEdge` descends that face (penalty-based child pick) to the node
  whose split edge is `(P,Q)`. The chain crosses faces and couples the equatorial
  base diamond at the root.
- **Conforming merge**: collapse only when BOTH diamond halves — `base` (the leaf's
  parent) and `top` (the parent's cross-face longest-edge neighbor) — are collapsible
  (`HeapRead ≤ 2`) AND want to coarsen (parent projected area < mergeThreshold).
  Gating on the base alone cracks the diamond.

Split (even frames) and merge (odd frames) alternate so the bitfield writes never
race; both decode from the stable sum tree (rebuilt only in the reduction pass).

## Per-frame GPU loop ([gpu_cbt_source.ts](../../../../src/systems/lod/cbt/gpu/gpu_cbt_source.ts))

1. **Update** (`cbt_update.compute.wgsl`, 1 thread/leaf, dispatch over the cap):
   decode leaf → projected area `worldArea·focal²/dist²` (mirrors `cbt_classify.ts`)
   → conforming split if too coarse / conforming merge if too fine. Backside-cull
   split candidates on the far hemisphere (forced splits from front-facing neighbors
   still reach them, so culling never opens a crack).
2. **Sum-reduction** (`cbt_sum_reduction.compute.wgsl`): one dispatch per level
   `D−1 … 0`; afterward the root = live leaf count.
3. **Render**: draw `forcedInstanceCount = 2^maxDepth` instances of a 3-vertex
   template; the vertex shader decodes `instanceIndex` → leaf → LEB triangle → corner
   → radial fbm displacement; `instanceIndex >= cbt_nodeCount()` → degenerate
   (clipped) triangle. Logarithmic depth (matches the other terrain shaders).
   Fragment recomputes the per-pixel normal from the analytic noise gradient.

## No indirect draw

Babylon exposes no public indirect-draw-count API, so the instance count can't come
from the GPU buffer. We draw a fixed cap (`2^maxDepth`) every frame and degenerate
instances beyond the live `nodeCount` read **in-shader** (always correct → no holes).
Over-draw is a trivial early-out vertex invocation.

## Telemetry

Main-thread cost is ~0 (a few uniform writes + dispatch calls). For the HUD leaf
count, `gpu_cbt_source` polls `kernel.readNodeCount()` every 30 frames — a tiny
non-blocking readback of the heap root (resolves over the render loop, no pipeline
stall) — and reports it via the `CbtGeometryListener`.

## Validation

- **CPU regression tests** (Vitest, port the WGSL decode + neighbor to JS and run a
  metric-driven refinement, asserting zero T-junctions):
  [conform_check.test.ts](../../../../src/systems/lod/cbt/gpu/conform_check.test.ts)
  (intra-face, sequential **and** batch = GPU-pass order) and
  [cross_face_check.test.ts](../../../../src/systems/lod/cbt/gpu/cross_face_check.test.ts)
  (cross-face: interior=0 AND seam=0, at a face-interior point and a point on a seam).
- **Live GPU** (T-junction detection: dump all leaf corners, a T-junction is an edge
  whose spherical midpoint is also a vertex elsewhere): **0 interior + 0 seam** at
  768 leaves and at 5388 leaves (deep close-up), ~32 FPS in the dev env.
- Bit-packing + sum-reduction were validated byte-identical to `CbtCpuHeap`; LEB
  decode matched the CPU reference to 7e-8 (f32).

## Limitations (v1, by design)

- **Depth capped at 18** (`GPU_MAX_DEPTH` in `cbt_scheduler.ts`): the simple path
  dispatches/draws `2^D` instances, so `D=25` (≈600 m triangles on Mercury) is
  deferred — it needs decoupling the draw/dispatch count from `D` via the live leaf
  cap. At D=18 triangles are coarser than the worker's D≈28 at very low altitude.
- **No self-shadow**: the `ShadowGenerator` depth pass would need a matching WGSL
  depth shader that decodes the implicit mesh.
- **No collisions**: there is no CPU `VertexData`, so `checkCollisions` / landing
  queries would need a separate CPU heightfield.

## WebGPU / BabylonJS gotchas (learned)

- `ComputeShader.dispatch()` **no-ops until `isReady()`** — `GpuCbtKernel.whenReady`
  polls before the first frame.
- `StorageBuffer` needs flag `WRITE` (CopyDst) for `update()` and `READ` (CopySrc)
  for `read()`. The heap also carries `INDIRECT`.
- One UBO **per reduction level** — a single UBO updated in a loop coalesces before
  submit (every dispatch would see only the last value).
- **No `;` inside `//` WGSL comments** — Babylon's WGSL processor splits statements
  on `;`, turning post-`;` comment text into a syntax error.
- A **vertex shader can read a read-only storage buffer** in WebGPU
  (`var<storage, read>`) — this is what makes the implicit mesh possible.
- WebGPU flips NDC-Y vs a hand-built `view·projection`; trust rendered screenshots
  over manual NDC math when debugging projection.
