# LOD Invariants

Use this checklist before and after every LOD change.

## Coordinate Space Contract

- Use `WorldDouble` for absolute positions and distance/SSE decisions.
- Use render-space for Babylon frustum checks and draw transforms.
- Use planet-local for worker mesh payloads and terrain shader local uniforms.
- Convert explicitly at boundaries. Avoid mixed-space math inside one formula.

## Hysteresis Contract

- Keep `ChunkTree.sseSplitThresholdPx > ChunkTree.sseMergeThresholdPx`.
- Keep at least a `1.0` pixel gap by default.
- If popping persists, widen the gap before increasing global detail level.

## Frame Budget Contract

- Keep `LodScheduler.budgetMs` finite.
- Keep recursion deadline checks active in `ChunkTree.updateLOD(...)`.
- Cap starts per frame (`maxStartsPerFrame`) to avoid burst allocations.

## Worker Contract

- Keep one protocol version (`mesh-kernel/1`) across pool, worker, and caller.
- Keep chunk result payload shape aligned with `worker_protocol.ts`.
- Preserve cancellation and stale-result guards (`cancel`, `pendingMeshToken`, `disposedFlag`).

## Rendering Contract

- Keep chunk visibility transitions one-sided during split warm-up.
- Avoid parent and all children visible together for long windows.
- Keep debug toggles non-blocking and optional (`debugLOD` paths).
