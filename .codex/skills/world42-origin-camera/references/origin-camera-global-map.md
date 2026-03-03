# OriginCamera Global Map

## Core Contract

- `OriginCamera` keeps render-space camera anchored near origin and stores absolute position in `doublepos`.
- Per-frame integration in `src/core/camera/camera_manager.ts`:
1. `doublepos += camera.position` (promote render delta to world).
2. `camera.position = (0,0,0)` (floating origin reset).
3. Update every `FloatingEntity` relative to `camera.doublepos`.
4. Compute `velocitySim` and `speedSim` from `doublepos` delta and wall-clock `dt`.

## Spaces and Units

- WorldDouble (simulation units): `camera.doublepos`, `FloatingEntity.doublepos`, star/planet absolute positions, LOD culling distances.
- Render-space: Babylon transforms and frustum checks after conversion.
- Planet-local: worker terrain mesh and shader-local vectors (converted from WorldDouble around planet pivot).
- Unit conversion: `ScaleManager` converts sim <-> km <-> meters.

## Integration Points

### Camera bootstrap

- `src/app/bootstrap_scene.ts`
- Spawn position is computed in WorldDouble from catalog body position.
- Camera target uses `camera.toRenderSpace(spawnBody.positionWorldDouble, out)`.
- Debug camera follows WorldDouble debug position converted by `toRenderSpace`.

### Player controls

- `src/core/control/mouse_steer_control_manager.ts`
- Input drives orientation and velocity in render-space (`camera.position` via collision-aware movement).
- Camera tick transfers render displacement into `doublepos`.

### Teleport

- `src/core/camera/teleport_entity.ts`
- Resolve target from `doublepos`, `position`, or `Vector3`.
- Set `camera.doublepos` to destination in WorldDouble.
- Recompute look target using `camera.toRenderSpace`.

### Runtime HUD and diagnostics

- `src/app/setup_runtime.ts`
- Distance logs use `camera.distanceToSim(...)`.
- HUD speed uses `camera.speedSim` converted to m/s via `ScaleManager`.

### LOD and culling

- `src/systems/lod/lod_scheduler.ts` passes `OriginCamera` into all root updates.
- `src/systems/lod/chunks/chunk_tree.ts` reads camera world position from `camera.doublepos`.
- Frustum planes come from `camera.getFrustumPlanesToRef`.
- Frustum sphere tests convert WorldDouble center with `camera.toRenderSpace(...)` or equivalent subtraction.
- `src/systems/lod/chunks/chunk_culling_eval.ts` explicitly documents WorldDouble -> Render conversion.

### Planet and star rendering

- `src/app/setup_lod_and_shadows.ts`
- Active planet selection and altitude use `camera.distanceToSim(...)`.
- Light vectors derive from world positions then applied in render/shadow context.

- `src/core/render/star_raymarch_postprocess.ts`
- Nearest star chosen by distance to `camera.doublepos`.
- Star center is converted with `camera.toRenderSpace`.
- Shader receives camera render origin via `camera.position` (expected near zero).

### Stellar catalog + floating entities

- `src/game_world/stellar_system/stellar_catalog_loader.ts`
- Bodies load absolute `positionWorldDouble`.
- Each body gets a `FloatingEntity` with `doublepos` and is attached to camera via `camera.add(ent)`.

## Invariants to Protect

- Never use `camera.position` for absolute world distance checks.
- Never feed WorldDouble directly to frustum tests without render conversion.
- Keep teleport and spawn target calculations on WorldDouble, then convert once to render-space.
- Keep speed telemetry based on `speedSim` (simulation units per second) and convert explicitly.
- Keep worker/chunk kernel contracts in planet-local space; convert camera/world vectors at boundaries.

## Quick Regression Checklist

1. Spawn points at intended orbital altitude.
2. Camera movement remains smooth at high distances (no precision jitter spikes).
3. Teleport points camera toward destination target immediately.
4. LOD root selection and chunk visibility remain stable while moving.
5. Star glow remains centered on nearest star after long travel.
