# CBT CPU Optimization — Measured Results

CPU-side improvements to the CBT terrain LOD (`src/systems/lod/cbt/`) bringing it
closer to the HPG 2024 paper **without** a WebGPU compute port yet. Every change
is guarded by golden + invariant tests and measured against a committed baseline.

## Measurement harness (Phase 0)

| Tool | Command / Key | What it measures |
|---|---|---|
| Micro-benchmarks | `npm run bench` (`vitest bench`) | CPU cost of hot pure functions (classify, noise, emit, state) |
| In-app perf HUD | press **P** in the running app | FPS, frame ms, GPU ms, draw calls, active indices, CBT leaves/splits/merges, rebuild ms |
| Headless capture | `node scripts/cbt_perf_capture.mjs --label <name>` | deterministic descent → `output/perf/<name>.json` (p50/p95 frame ms, max leaves, rebuilds) |
| Compare runs | `node scripts/cbt_perf_compare.mjs baseline <name>` | delta table between two capture JSONs |
| Regression | `npm test` | golden topology+mesh hashes (`cbt_golden.test.ts`) + structural invariants (`cbt_invariants.test.ts`) |

- Stats are exported from `CbtScheduler.getStats()` / `getPlanetInfo()` and surfaced
  to the HUD/capture via the dev hook `window.__world42Perf`.
- Deterministic fixtures live in `src/systems/lod/cbt/__fixtures__/cbt_fixtures.ts`
  (shared by benches and tests).
- **Browser capture requires Playwright** (not a default dep). Enable with
  `npm i -D playwright && npx playwright install chromium`. Until then, use the
  in-app HUD (press P) for end-to-end numbers; the bench harness covers the
  per-function CPU costs.

## Phase 1 — single-pass classify + merge

`CbtPlanet.update` previously ran `measureLeafProjectedAreas` **and**
`classifySplitCandidates` (two O(n) passes) plus a separate merge-aggregation
loop. Replaced by one `classifyLeaves()` pass computing each leaf's projected
area once and deriving both split candidates and merge parents.

- **Behavior-preserving**: golden hashes unchanged; `classifyLeaves` proven to
  match the legacy two-pass split set and merge-parent list exactly (invariants).
- **Measured** (classify+merge per-frame cost, fair baseline incl. merge agg):
  - 1k leaves: 0.243 ms → 0.204 ms (~16%)
  - 5k leaves: 1.18 ms → 1.02 ms (~13%)
  - 20k leaves: 4.73 ms → 3.99 ms (~16%)
- **Discovered**: the dominant cost is the **merge-aggregation Map** (~3 ms of the
  4 ms at 20k), not the duplicated area pass. That Map is the next lever (e.g.
  aggregate without per-parent object allocation, or off the leaf list).

## Phase 3 — inline math in `triangleArea`

Replaced `v1.subtract(v0)` / `Vector3.Cross` / `.length()` (3 `Vector3`
allocations per leaf per frame) with scalar cross-product math, same operation
order.

- **Bit-identical**: golden hashes unchanged.
- **Measured**: classify mean ~2–8% faster (size-dependent); the larger win is
  eliminating 3 allocations/leaf/frame → fewer GC pauses → steadier p95 frame
  time in the running app (best seen via HUD/capture, understated by warmed-up
  bench means).

## Phase 2 — backside culling

`classifyLeaves` now excludes far-hemisphere leaves from split candidates
(`dot(surfaceNormal, dirToCamera)` test with a small guard band, default
`cullMinDot = -0.05`). **Merges are not culled**, so off-screen detail is still
reclaimed. Flag-gated (`cullBackface`, default **off** in the classify functions,
**on** in the scheduler) so golden and the Phase-1 equality invariant stay valid.

- **Guarded**: invariants prove culling only removes split candidates (strict
  subset), every removed leaf is genuinely back-facing, and merges are unaffected.
- **Measured** (deterministic descent, leaf count at a fixed pose):
  - up to **94% fewer leaves** at close range in the synthetic descent
    (1024 → 60); realistic poses ≈ **~50%** (the back hemisphere).
  - This is a *structural* win (the far side stops subdividing) — it shows up as
    leaf/vertex count and accumulated classify cost over time, not in a
    fixed-set micro-bench.
- **⚠ Requires a visual check**: fly toward a CBT planet and rotate; watch for
  silhouette pop or cracks. Tune `cullMinDot` (more negative = wider guard band,
  less pop, fewer culled). Disable per-planet via `CbtPlanetOptions.cullBackface`.

## Phase A1 — typed-array pool (replaces Map/Set)

`CbtState` internals rewritten to a Structure-of-Arrays pool (paper P1+P2): `verts`
(Float64Array, f64 to preserve tree precision), `level`/`parent`/`child0`/`child1`, plus
`alive` and `leafBits` bitfields and a free-list allocator. Pure geometry helpers
(`splitByLongestEdge` etc.) reused verbatim. Public API unchanged.

- **Geometry preserved**: golden hashes were first made **id- and order-independent**
  (canonical by centroid) so they assert geometry not bookkeeping; the pool keeps them green.
  (Also fixed a latent test flaw: the golden scenario now splits *all* candidates per round,
  removing an order-dependent tie at the per-round split cap.)
- **`getLeafNodes()`** is now cached (dirty-flagged on split/merge) and returns reused,
  per-slot pooled `CbtNode` views — **free on cache hits** (steady camera) and **zero-alloc**
  when rebuilt on churn frames (vs the old Map returning fresh refs each call).
- Enables the neighbour table (A2) and incremental mesh (A3): every node now has a stable
  integer slot id.

## Phase A2 — neighbour table + conformity (fixes cracks)

`CbtState` is now a **ROAM binary-triangle** tree: each node is `(apex, left, right)`
with the split edge as its hypotenuse, so the base neighbour is always well defined.
A `neighbors Int32Array(cap*3)` table (`[base, left, right]`) is maintained on every
split/merge, and refinement uses the **forced-diamond split** (Rivara/Duchaineau
compatibility chain): splitting a triangle first force-splits its base neighbour so the two
refine together, keeping the mesh watertight. Decimation is conservative — a diamond
collapses only when all four of its triangles are leaves.

- **Seeding**: the 8 octahedron faces are paired into 4 base-edge diamonds
  (`{0,4} {1,5} {2,6} {3,7}`), apex at the poles, hypotenuse on the equator.
- **Crack fix proven by test** (`cbt_conformity.test.ts`, geometry-only — no neighbour
  introspection): after deep single-spot and multi-spot adaptive refinement, **every edge
  is shared by exactly two leaves (no T-junctions)** and the mesh stays **restricted**
  (edge-adjacent leaves differ by ≤1 level).
- **Emit winding fix**: `emitMeshFromLeaves` now orients each triangle's front face outward
  from the geometric normal (bintree vertex order isn't consistently wound), replacing the
  old fixed flip — prevents back-face-culled holes.
- **Semantics change**: a split now refines a *diamond* (+2 leaves, plus any forced
  neighbours), and a merge collapses a diamond (−2). Existing state/invariant tests and the
  golden snapshots were updated/re-blessed accordingly (geometry is the new bintree surface;
  the golden hashes remain id/order-independent).
- **Visual check (required, user step)**: `npm run serve` → fly to a CBT planet, **W**
  (wireframe) / **X** (LOD colours); confirm no cracks at level boundaries and silhouettes.
  Tune the merge cadence if pop is visible; geomorph (popping) is intentionally out of scope.

## Phase A3 — incremental mesh (kills rebuild spikes)

`CbtEmitCache` caches each leaf's computed vertex data (positions/normals/uvs/colors) keyed
by its **stable slot id**, detecting reuse by comparing the cached `(v0,v1,v2)`. On a rebuild
it recomputes noise only for slots whose geometry actually changed — the handful created by a
split — and copies cached data for the rest. The full emitter and the cache share one
`computeLeafVertexData` helper, so output is **byte-identical** (proven by
`cbt_emit_incremental.test.ts`). Wired into `CbtPlanet.rebuildMesh` behind
`CbtPlanetOptions.incrementalMesh` (default on) with the full rebuild as fallback.

- **Measured** (mesh rebuild, steady state / geometry unchanged vs the pre-A3 full noisy rebuild):
  - 1k leaves: 6.2 ms → 0.23 ms (**~27×**)
  - 5k leaves: 35 ms → 0.99 ms (**~35×**)
  - i.e. the rebuild collapses to the copy/assemble cost; noise is recomputed only for changed
    slots. On change frames the cost is `(noise × changed slots) + O(n) copy`, not
    `noise × all leaves`.
- Verified: cache hit recomputes 0 slots on an unchanged tree; a single split recomputes only
  a few (≪ leaf count); byte-identical to the full emitter before and after refinement.
- Note: this is an incremental **compute** cache (eliminates the dominant noise cost). Sub-range
  GPU buffer uploads + a fixed slot→vertex layout remain a future refinement; the GPU upload of
  the assembled buffer is a cheap memcpy next to the noise it removed.

## Startup fix — backside cull + LOD pre-warm

Two startup bugs found via in-app testing (spawn = Mercury, camera at 1.01× radius over the pole):

1. **Stuck at minimum LOD (root cause: over-aggressive backside cull).** The A2 cull tested
   only the triangle **centroid**. At very low altitude the 8 huge root triangles have
   centroids far from the sub-camera point, so all 8 tested back-facing and were removed from
   split candidates — nothing could subdivide, so the planet stayed at ~8 leaves until the
   camera moved away. Fixed: a triangle is culled only when **all three vertices** are behind
   the horizon (`triangleBackface` in `cbt_classify.ts`), so a big coarse triangle straddling
   the horizon still splits and produces front-facing children. The per-vertex test runs only
   for area-qualifying candidates, so classify cost is unaffected in the common case.
   Regression test: `cbt_invariants.test.ts` "does NOT cull a huge coarse triangle that
   straddles the horizon".
2. **Slow cold ramp.** `CbtScheduler.prewarm()` synchronously refines all planets toward the
   spawn camera (time-bounded, default 120 ms) before the first render, via
   `setup_lod_and_shadows.ts`, so the spawn planet is detailed on frame 1 instead of ramping
   over ~1-2 s.

Verified live: spawn now reaches ~5k leaves within a few seconds and renders detailed terrain
immediately (was stuck at ~24 leaves before).

## Deferred (not in this pass)

- Typed-array heap + bitfield replacing `Map<number, CbtNode>` (paper structure;
  unlocks incremental mesh + neighbor table).
- Incremental mesh update instead of full `emitMeshFromLeaves` rebuild.
- Neighbor table for T-junction prevention.
- **Noise offload**: `emitMeshFromLeaves` with noise is ~27× the geometry-only
  cost (per-vertex fbm + finite-difference normal); a strong WASM candidate.
