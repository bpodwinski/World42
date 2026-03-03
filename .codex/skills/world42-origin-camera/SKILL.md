---
name: world42-origin-camera
description: Analyze and safely evolve World42 OriginCamera floating-origin behavior end-to-end. Use when requests mention OriginCamera, doublepos vs position, teleport/camera placement, camera speed/velocity metrics, world/render conversion bugs, or when editing camera integrations in src/core/camera/, src/core/control/, src/app/, src/systems/lod/, and render postprocess paths.
---

# World42 Origin Camera

Treat `OriginCamera` as the world/render boundary for the entire runtime. Keep all edits consistent with this contract:
- WorldDouble (high precision): `camera.doublepos`, entities `doublepos`, absolute distances.
- Render-space (Babylon transforms): `camera.position` and visible mesh transforms.
- Conversion boundary: `toRenderSpace` and `toWorldSpace`.

## Workflow

### 1) Audit usage before editing

Run:

```powershell
./skills/world42-origin-camera/scripts/check-origin-camera-usage.ps1
```

Inspect:
- Any logic mixing `camera.position` with world distances.
- Direct `world - camera.doublepos` math that should use `toRenderSpace`.
- Any new code writing to render-space and world-space in the same formula.

### 2) Preserve frame contract

When touching `src/core/camera/camera_manager.ts`, keep this update order inside the camera tick:
1. Accumulate render delta into `doublepos`.
2. Reset `camera.position` to render origin.
3. Update all floating entities.
4. Update velocity and speed from `doublepos`.

Do not reorder those steps without checking downstream systems.

### 3) Keep system boundaries explicit

- Controls (`mouse_steer_control_manager.ts`) move in render-space; camera tick promotes motion to WorldDouble.
- Teleport (`teleport_entity.ts`) sets `doublepos` and look target using `toRenderSpace`.
- LOD/culling (`chunk_tree.ts`, `chunk_culling_eval.ts`) read camera location from `doublepos`.
- Postprocess (`star_raymarch_postprocess.ts`) sends camera render origin and world-derived targets converted to render-space.

If you add a new camera consumer, choose one space first, then convert once at the boundary.

### 4) Validate high-risk changes

After changes to OriginCamera behavior:
- Verify spawn/target setup in `bootstrap_scene.ts`.
- Verify teleport + LOD reset in `setup_runtime.ts`.
- Verify near-planet shadows and active-planet selection in `setup_lod_and_shadows.ts`.
- Verify speed HUD (`camera.speedSim` -> `ScaleManager.simSpeedToMetersPerSec`).

Use `references/origin-camera-global-map.md` for file-level contracts.

## Resources

- Script: `scripts/check-origin-camera-usage.ps1`
- Reference: `references/origin-camera-global-map.md`
