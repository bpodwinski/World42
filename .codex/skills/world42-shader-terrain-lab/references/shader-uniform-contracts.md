# Shader Uniform Contracts

## Terrain shader contract

Files:
- `src/assets/shaders/terrain/terrainVertexShader.glsl`
- `src/assets/shaders/terrain/terrainFragmentShader.glsl`
- `src/game_objects/planets/rocky_planet/terrains_shader.ts`
- `src/systems/lod/chunks/chunk_forge.ts`

Rules:
- Every GLSL `uniform` used by terrain shaders must be declared in `ShaderMaterial` uniform/sampler lists.
- Every non-engine uniform should have a deterministic default set in `TerrainShader.create`.
- Shadow uniforms (`lightMatrix`, `shadow*`, `shadowSampler`) must remain valid when no shadow context exists.
- `uPatchCenter` must stay planet-local and match chunk-forge conversion path.

## Atmosphere contract

Files:
- `src/assets/shaders/atmosphericScatteringFragmentShader.glsl`
- `src/game_objects/planets/rocky_planet/atmospheric-ccattering-postprocess.ts`

Rules:
- `SHADER_UNIFORMS` and `SHADER_SAMPLERS` arrays must match GLSL declarations.
- `onApplyObservable` must set each required runtime uniform every frame.
- Camera and planet vectors should remain consistent with postprocess expectations.

## Common failure signatures

- Black terrain: missing sampler binding or NaN light/shadow values.
- Flat lighting: light direction not normalized or wrong space.
- Shadow acne/peter-panning: bias/normalBias contract drift.
- No atmosphere effect: missing depth sampler or matrix uniforms.
