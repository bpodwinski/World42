# 🌐 OCBT — Pool-based Concurrent Binary Tree terrain engine

GPU terrain LOD engine based on **"Concurrent Binary Trees for Large-Scale Game
Components"** (Benyoub & Dupuy, HPG 2024). The CBT is used as a **fixed-capacity memory
pool allocator**; the triangulation is stored as **explicit bisectors** (heap id +
neighbour links) rather than implicitly in a `2^D` bitfield. Result: per-frame cost and
memory are **decoupled from subdivision depth** — they scale with the fixed pool capacity
and the live triangle count, not `2^depth`.

This replaces the implicit GPU CBT path (`../gpu/`, Dupuy 2021) whose `O(2^D)`
sum-reduction capped playable depth at ~25.

> Status: **Phases 0–2 complete, Phase 3 (precision/perf) substantially complete.** The
> paper's central goal — decoupling cost from depth — is achieved and validated.
> Crack-free render to ~level 27 at the surface; usable-depth ceiling ~45 (emulated f64),
> structural hard cap 60 (u64 heap id). See [Status vs paper & plan](#-status-vs-paper--plan).

---

## 🚀 Enable & validate

- **In-app (dev):** open the live app with `?cbt=ocbt` (e.g. `http://localhost:19000/?cbt=ocbt`).
  Wired in [`../../../../app/setup_lod_and_shadows.ts`](../../../../app/setup_lod_and_shadows.ts);
  backend selected by the `cbtType: 'cpu' | 'gpu-implicit' | 'gpu-ocbt'` enum in
  [`../cbt_scheduler.ts`](../cbt_scheduler.ts) (`createSource`). Tuning constants
  (capacity, maxLevel, split/merge px) live in that `createSource` branch.
- **GPU topology cross-check (dev page):** `http://localhost:19000/ocbt-topo-test.html`
  runs every scenario on **both** the direct and indirect-dispatch paths and compares the
  GPU mesh to the sequential CPU oracle by geometry. Publishes `window.__OCBT_TOPO_RESULT__`
  (`{pass, cases}`); currently **20/20 green**. Entry gated dev-only in `rspack.config.js`.
- **Unit tests:** `npm test` — the pool allocator, u64/f64 emulation, LEB decode, and the
  full CPU topology oracle (incl. an adversarial stress suite) are covered in Node/Vitest
  (no WebGPU). WebGPU shaders are validated via the dev pages above.

---

## 🧱 Architecture

WebGPU only. The engine is a **GPU-resident bisector pool**; the main thread only writes a
few uniforms and issues dispatches per frame. Two consumers share the same kernel:
- the **render path** (`OcbtSource`, metric classify, df64 eval, compaction, indirect dispatch),
- the **cross-check** (`ocbt_topology_gpu_test_main`, predicate classify, f32 eval) which
  proves the GPU engine against the CPU oracle.

### TypeScript (`src/systems/lod/cbt/ocbt/`)

| File | Role |
|---|---|
| `ocbt_pool.ts` | Pool constants/offsets/masks (single source for TS + WGSL). |
| `ocbt_u64.ts` / `ocbt_f64.ts` | CPU mirrors of the emulated u64 (`vec2<u32>`) and df64 (double-single) ops — the oracles for the WGSL emulation tests. |
| `ocbt_leb.ts` | Legacy LEB decode (World42 `cbt_leb` convention) — used by the oracle. |
| `ocbt_eval_leb.ts` | **Reference-convention** vertex decode (`ocbtCorners`, `GPU_FACE_CORNERS`) — the convention the GPU engine actually stores heap ids in. Render path uses THIS, not `ocbt_leb`. |
| `ocbt_cpu_mirror.ts` | CPU mirror of the pool allocator (Phase 0 oracle). |
| `ocbt_topology.ts` | **CPU oracle** of the full topology engine (explicit bisectors, LEPP split, conservative merge, depth cap). The gold standard the GPU is checked against. |
| `ocbt_buffers.ts` / `ocbt_engine_buffers.ts` | Buffer sizing + binding map + octahedron seed (single source of truth, Node-testable). |
| `ocbt_topology_kernel.ts` | **The kernel.** Owns every StorageBuffer + ComputeShader, builds the seed, runs the per-frame pass order. `classifyMode: 'predicate' | 'metric'`, `useIndirect` flag. |
| `ocbt_render_material.ts` | WGSL render material (implicit mesh; VS reads the compacted index list + camera-relative positions buffer). |
| `ocbt_source.ts` | `CbtGeometrySource` impl: owns kernel + mesh + material, drives the per-frame metric + camera + frustum, `forcedInstanceCount` from readback. |
| `*.test.ts` | Vitest suites. `ocbt_topology_stress.test.ts` is the adversarial watertightness suite. |
| `ocbt_*_gpu_test_main.ts` | Dev-page entry points (pool + topology cross-checks). |

### WGSL (`src/assets/shaders/cbt/ocbt/`)

`ocbt_u64.wgsl`, `ocbt_f64.wgsl` (emulation), `ocbt_pool.wgsl` (allocator),
`ocbt_eval_leb.wgsl` (reference decode), `ocbt_topo_common.wgsl` (shared consts/helpers),
and one `*.compute.wgsl` per pass: `reset`, `classify` (+`classify_metric`), `split`,
`allocate`, `copy_neighbors`, `bisect`, `propagate_bisect`, `prepare_simplify`, `simplify`,
`propagate_simplify`, `eval_leb` (+`eval_leb_f64`), `compact`, `prepare_indirect`,
`ocbt_pool_reduce`.

---

## 🔁 Per-frame pipeline

Split frame (`runFrame`) and merge frame (`runMergeFrame`) alternate by parity in the
render path. Pass order mirrors the reference `mesh_updater.cpp`:

```
Reset → Classify → Split → Allocate → CopyNeighbors → Bisect → PropagateBisect → Reduce
        (merge)  → PrepareSimplify → Simplify → PropagateSimplify → Reduce
then (render):  EvalLeb (df64, camera-relative) → Compact (live → index list)
```

- **Classify** builds the split/simplify candidate lists (metric = screen-space edge px +
  frustum/backside cull; predicate = deterministic per-face level for the cross-check).
- **Split** = concurrent LEPP: atomic free-slot reservation + BASE/twin-walk forcing.
- **Bisect** = 4 patterns (CENTER / RIGHT_DOUBLE / LEFT_DOUBLE / TRIPLE) + neighbour fix-up.
- Neighbours **ping-pong** (two buffers, swap per split frame); merge rewires **in place**.
- **EvalLeb** decodes each live slot in **df64**, emits the corner **camera-relative**
  (`dir*radius − camLocal`) narrowed to f32 (per-vertex precision survives to the GPU).
- **Compact** appends live slots to a contiguous index list so the draw issues
  `liveCount` instances, not `capacity`.

---

## 🔑 Key conventions & hard-won decisions

1. **Octahedron seed orientation (the headline Phase 1 blocker).** The reference engine's
   `evaluate_neighbors` requires a **consistently-oriented** octahedron (every shared edge
   traversed in opposite directions by its two faces). World42's `lebFaceCorners` +
   `ROOT_NEIGHBORS` wind the 4 top faces opposite to the 4 bottom — so the GPU seed
   (`ROOT_NEIGHBORS_W42` in `ocbt_engine_buffers.ts`) swaps L/R for the top faces, and the
   matching `GPU_FACE_CORNERS` (in `ocbt_eval_leb.ts`) swaps their l/r. This single fix made
   geometry decode + watertightness + conformity counts all correct.
2. **Decode convention.** The GPU stores heap ids in the **reference leb** convention
   (seed v0=right, v1=apex, v2=left, spherical midpoints) over `GPU_FACE_CORNERS` — NOT the
   legacy `ocbt_leb`/`cbt_leb` convention. The render path must decode with `ocbt_eval_leb`.
3. **Precision (Phase 3).** WGSL has no native f64 and World42's `doublepos` is f32. The
   depth-24 f32 ceiling has two causes: the normalize chain in the decode, and the
   per-vertex `dir*radius` (~0.24 m ULP at planet scale). Fix: decode in **df64** and emit
   **camera-relative** (`dir*radius − camLocal` in df64, narrowed). camLocal's f32 error is a
   uniform per-frame patch translation (invisible), not per-vertex jitter — so it can't crack.
4. **Frustum culling concentrates the pool.** Without it, the whole visible hemisphere
   refines and saturates the pool at ~L32 regardless of altitude. The metric tests each leaf
   against the camera frustum in **camera-relative planet-local space** (`Rᵀ·n`, d unchanged);
   off-screen leaves are coarsened → the pool concentrates on what's visible → depth unblocks.
5. **Validation = geometry, not labels.** GPU and oracle use different heap-id conventions,
   so the cross-check compares **geometry** (sorted centroid keys) + neighbour reciprocity +
   watertightness (shared full edges) + GPU-vs-TS decode, never raw heap ids.

---

## 📊 Status vs paper & plan

**Achieved (the paper's core):** cost/memory decoupled from depth (pool allocator +
explicit bisectors); the concurrent topology engine ported faithfully and proven watertight
for refine + coarsen; draw compaction + indirect dispatch (work-list passes scale with
candidate counts).

**Below paper parity:**

| Aspect | Reference (`large_cbt`) | Here | Note |
|---|---|---|---|
| Depth precision | **native FP64** → depth 63 clean | **emulated df64** + f32 floating-origin | usable ~L45; structural hard cap 60 (u64). *The main gap — a WGSL limitation, not a port bug.* |
| Sum-reduce | packed variable-bit-width tree | simple `2·capacity` tree | the dominant remaining `O(capacity)` cost |
| LEB matrix cache | yes (`O(depth/5)`) | per-step df64 decode (`O(depth)`) | only matters pushing toward 60 |

**Dropped by design** (World42 = fixed octahedron, one planet, forward rendering): half-edge
loader, FFT ocean, impostors, deferred visibility-buffer, elevation textures.

**Honest perf note:** indirect dispatch removes ~7 full-capacity dispatches that did <5%
useful work (~10–40% of the topology-update *dispatch* portion). It is **not** asymptotic —
the floor stays `O(capacity)` because Classify, Compact, CopyNeighbors and (dominant) Reduce
must traverse the whole pool every frame.

### Remaining perf work (ranked by leverage)

1. **Pool Reduce → packed variable-bit-width tree** (now the dominant `O(capacity)` cost).
2. **CopyNeighbors → O(live)** (iterate the index list; flagged risky for the ping-pong
   invariant — validate carefully before shipping).
3. **LEB matrix cache** (to raise usable depth past ~45 toward 60).
4. **EvalLeb → indirect** (only after reordering Compact before EvalLeb).

---

## ⚠️ WebGPU / Babylon gotchas (learned the hard way)

- `target` is a **WGSL reserved keyword** (bit twice — renamed to `tgt`).
- A ComputeShader that declares but never uses a binding gets it **stripped** by reflection
  — don't bind a stripped slot or the bind group is invalid.
- A freshly created `StorageBuffer` is **not** guaranteed zero-initialized — gate rendering
  until the seed is uploaded (else garbage heap ids → NaN triangles, the "white flash").
- `StorageBuffer.update` is only proven **full-size** in this project; partial updates are
  avoided (seed/targets written zero-padded full-size).
- Indirect dispatch: args buffer needs `STORAGE | INDIRECT | WRITE`; consumers read the X
  workgroup count via `@builtin(num_workgroups).x` so the 2D spill stays self-consistent;
  keep the in-shader `if (i >= count) return;` guard (ceil rounds up to a multiple of 256).
- `readback` with no render loop needs `StorageBuffer.read(0, undefined, undefined, true)`
  (forced flush+submit).
