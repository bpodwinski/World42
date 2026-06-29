# Off-thread CBT (Rust/WASM worker)

The full CBT pipeline (classify + split/merge + emit + noise) runs in a dedicated
Rust/WASM Web Worker. The main thread only uploads the finished geometry
(`applyToMesh`). Selected by the `offThreadCbt` flag (default **true**) in
[setup_lod_and_shadows.ts](../../../../src/app/setup_lod_and_shadows.ts); the
synchronous TS path stays as the fallback **and** the golden-test reference.

## Architecture

- **One dedicated worker** ([global_cbt_worker.ts](../../../../src/systems/lod/cbt/workers/global_cbt_worker.ts)),
  separate from the CDLOD `globalWorkerPool`. It is **stateful**: it owns every
  planet's tree (`Map<key, CbtKernel>`) and round-robins via the per-frame message
  stream. No SharedArrayBuffer (see below) — the worker owning the tree is what
  makes plain transferables sufficient.
- **Protocol `cbt-kernel/1`** ([cbt_worker_protocol.ts](../../../../src/systems/lod/cbt/workers/cbt_worker_protocol.ts)):
  `init→ready`, `create_planet`, `update_planet→geometry_result`, `reset_planet`,
  `dispose_planet`, `error`.
- **Latency**: one `update_planet` in flight per planet; the latest camera is
  coalesced while a request is outstanding and re-sent on the result. A monotonic
  `gen` per planet drops stale results.
- **Geometry** returns via transferables (6 ArrayBuffers); `update_planet` does NOT
  transfer its tiny params buffer (a 24/48-double copy is cheaper).
- **Camera params** are packed into one `Float64Array` so WorldDouble (f64) survives
  structured clone. Layout in cbt_kernel.rs / packFrame: `[0..3]` camera, `[3..6]`
  planet center, `[6..22]` render matrix, `[22]` focal, `[24..48]` 6 frustum planes.

## Rust crate ([terrain/src/cbt/](../../../../terrain/src/cbt/))

Pure-numeric, host-testable modules + a thin wasm-bindgen wrapper:
- `cbt_noise.rs` — Gustavson simplex + FBM + seeded perm (NOT the OpenSimplex used
  by `build_chunk`).
- `cbt_state.rs` — ROAM pool, forced-diamond split, conservative merge.
- `cbt_classify.rs` — projected area, backside + frustum culls.
- `cbt_emit.rs` — per-leaf vertices + incremental cache.
- `cbt_kernel.rs` — `#[wasm_bindgen] CbtKernel` (one per planet): `new`, `update`,
  `reset_now`, `prewarm`.

Single crate / single `.wasm` shared by both workers. Build:
`wasm-pack build terrain --release --target web --out-dir pkg`.

## Bit-exactness contract (the validation that de-risks this)

Validated by `cargo test` against fixtures dumped from the REAL TS pipeline
(IEEE-754 hex bits; generators: `terrain/tools/gen_noise_fixture.ts` and
`src/systems/lod/cbt/cbt_scenario_fixture.gen.test.ts`, run with
`GEN_CBT_FIXTURE=1`):

- **Noise height field**: bit-identical (no transcendentals — only `+ * floor & %`).
- **Topology** (leaf id/level/parent + vertices): bit-identical (integer pointers +
  `+ * floor sqrt`, exact IEEE-754).
- **Positions / normals / colors / indices**: bit-identical after `f64 as f32`.
- **UVs only**: within an ULP tolerance (`atan2`/`asin`). UVs are cosmetic (the
  per-pixel-normal shader ignores the emitted UV/normal) and feed back into nothing,
  so the topology stays exact.

The one externalized transcendental is `focal = viewportHeightPx / (2·tan(fov/2))`:
computed on the **main thread** (JS `Math.tan`) and sent to the worker, so a libm/JS
`tan` ULP difference can never flip a split decision and diverge the topology.

## No SharedArrayBuffer (GitHub Pages constraint)

GitHub Pages cannot set COOP/COEP headers → `crossOriginIsolated` is false and
`SharedArrayBuffer` is unavailable in production. Verified live: with
`crossOriginIsolated === false` and `SharedArrayBuffer` undefined, the worker still
runs (camera in via copy, geometry out via transferables). Do NOT introduce SAB.

## Telemetry

In worker mode, `CbtStats.classifyMs` is the worker's compute time (off the main
thread) and `rebuildMs` is just the main-thread `applyToMesh` (GPU upload) — the
only irreducible main-thread cost. Live close-up (~62k leaves): classifyMs ≈ 11 ms
off-thread, rebuildMs ≈ 3 ms on-thread.

## Prewarm

`create_planet` carries an optional spawn frame + `maxIters`; the worker refines
toward it and returns the first (already-detailed) `geometry_result` — non-blocking
for the main thread. Verified: spawn shows ~13k leaves immediately vs ~5k without.
