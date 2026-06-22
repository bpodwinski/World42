# Shader Debug Playbook

## Terrain debug sequence

1. Enable `debugLOD` path first.
2. Confirm color transitions map to expected `lodLevel`.
3. Switch to `debugUV` if seams or triplanar blends look wrong.
4. Disable both debug modes before assessing final lighting.

## Lighting and shadows checks

- Verify `lightDirection` is normalized on TS side before binding.
- Validate `shadowSampler` fallback path (dummy texture) still works without context.
- Adjust `shadowBias` and `shadowNormalBias` incrementally; keep changes small.

## Atmosphere checks

- Confirm `depthSampler` exists and updates each frame.
- Confirm inverse projection/view matrices are set from the active camera.
- Confirm planet radius and atmosphere radius are in the expected units for this effect path.

## Safe change pattern

- Change one subsystem at a time: terrain shading, shadowing, then atmosphere.
- Re-run binding audit script after each uniform/sampler change.
- Keep debug toggles functional after refactors.
