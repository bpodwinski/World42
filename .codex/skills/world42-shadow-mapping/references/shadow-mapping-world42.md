# Shadow Mapping World42

## Architecture Map

- Setup: `src/app/setup_lod_and_shadows.ts`
- Runtime context: `src/game_objects/planets/rocky_planet/terrains_shader.ts`
- Sampling logic: `src/assets/shaders/terrain/terrainFragmentShader.glsl`
- Caster lifecycle: `src/systems/lod/chunks/chunk_forge.ts`

World42 currently uses two directional shadow maps:
- Near map for local detail
- Far map for distance coverage

The terrain shader blends near and far visibility based on distance to `cameraPosRender`.

## Coordinate and Depth Rules

- Compute star and planet relations in WorldDouble.
- Project and sample shadows in render-space.
- Respect reverse depth and NDC range flags:
  - `shadowReverseDepth`
  - `shadowNdcHalfZRange`

## Uniform Contract (must stay aligned)

TypeScript provides:
- `shadowSamplerNear`, `shadowSamplerFar`
- `lightMatrixNear`, `lightMatrixFar`
- `shadowTexelSizeNear`, `shadowTexelSizeFar`
- `shadowBias`, `shadowNormalBias`, `shadowDarkness`
- `shadowReverseDepth`, `shadowNdcHalfZRange`
- `shadowBlendStart`, `shadowBlendEnd`
- `cameraPosRender`

GLSL consumes the same names in `terrainFragmentShader.glsl`.

## Tuning Entry Points

- Global setup knobs:
  - map sizes (`NEAR_SHADOW_MAP_SIZE`, `FAR_SHADOW_MAP_SIZE`)
  - dynamic ranges (`nearShadowRange`, `farShadowRange` + min/max clamps)
  - context bias (`shadowCtx.bias`, `shadowCtx.normalBias`)

- Shader knobs:
  - Poisson kernel radius scaling (`2.0 * shadowTexelSize*`)
  - receiver bias formula (`shadowBias + (1 - ndl) * shadowNormalBias`)
  - blend function around `shadowBlendStart`/`shadowBlendEnd`

## Regression Risks

- Updating only one cascade path (near or far) and leaving the other stale.
- Changing a uniform name in TS without GLSL update.
- Forgetting caster deregistration on chunk dispose.
- Mixing WorldDouble vectors directly in render-space shadow projection.
