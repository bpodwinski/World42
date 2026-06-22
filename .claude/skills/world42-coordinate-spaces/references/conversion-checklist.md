# Conversion Checklist

Use this checklist in reviews and refactors.

## Before editing

- Identify the source space of each operand.
- Identify the target space of each output.
- Confirm whether units are km or sim.

## During editing

- Keep each formula in one space.
- Convert at entry points, not mid-formula.
- Prefer existing helpers over ad hoc subtraction.

## Common safe patterns

- World to render:
  `camera.toRenderSpace(worldPos, out)`
- Render to world:
  `camera.toWorldSpace(renderPos, out)`
- Local to world:
  `localToWorldDouble(local, pivotWorldMatrix, planetCenterWorldDouble, out)`
- km to sim:
  `ScaleManager.toSimulationUnits(km)`

## Common risky patterns

- Using `camera.position` for LOD distance logic.
- Directly adding a local vector to `doublepos` without pivot rotation.
- Copying worker local data into world/render uniforms unchanged.
- Combining catalog `*_km` fields with sim values without conversion.

## Final verification

- Teleport and spawn land at expected planet-relative locations.
- LOD split/merge remains stable while moving camera.
- Shadow/light direction remains coherent when planet rotates.
