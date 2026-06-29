---
name: world42-shadow-mapping
description: Tune and debug World42 terrain shadow mapping across near/far directional cascades, TerrainShadowContext wiring, terrain shader sampling, and chunk caster registration. Use when shadows flicker, acne or peter-panning appears, cascade seams are visible, shadows drift during camera motion, or when editing src/app/setup_lod_and_shadows.ts, src/game_objects/planets/rocky_planet/terrains_shader.ts, src/assets/shaders/terrain/terrainFragmentShader.glsl, and src/systems/lod/chunks/chunk_forge.ts.
---

# World42 Shadow Mapping

Keep shadow logic consistent with the current World42 pipeline: two directional shadow maps (near and far), blended in the terrain fragment shader.

## Core Space Contract

- Use WorldDouble for absolute star, planet, and camera positions.
- Convert to render-space before shadow projection/sampling.
- Keep all values in one space per formula.

Rule of thumb:
- Distances and planet/star selection: `camera.doublepos` (WorldDouble).
- Shadow projection and sampling: render-space (`vWorldPosRender`, `camera.position`).

## Workflow

### 1) Audit before editing

Run:

```powershell
./.codex/skills/world42-shadow-mapping/scripts/check-shadow-mapping-usage.ps1
```

Scan for contract breaks:
- Missing near/far context updates.
- Uniform mismatch between TypeScript and GLSL.
- Missing shadow caster registration on terrain chunks.

### 2) Preserve producer and consumer contracts

Producer (`src/app/setup_lod_and_shadows.ts`):
- Build two `ShadowGenerator`s (near/far).
- Update light direction from star to planet in render-space.
- Update near/far orthographic ranges and texel snapping each frame.
- Push matrices and blend window into `TerrainShadowContext`.

Consumer (`src/game_objects/planets/rocky_planet/terrains_shader.ts`):
- Bind `shadowSamplerNear/Far`, `lightMatrixNear/Far`, texel sizes, bias values, blend range, and depth flags on each bind.

Shader (`src/assets/shaders/terrain/terrainFragmentShader.glsl`):
- Compute slope-aware receiver bias.
- Sample near and far shadow maps with Poisson PCF.
- Blend near/far visibility by camera distance.

Mesh lifecycle (`src/systems/lod/chunks/chunk_forge.ts`):
- Register each terrain chunk as caster in both generators.
- Remove casters on mesh dispose.

### 3) Tune by symptom

- Acne: increase `shadowBias` and/or `shadowNormalBias` slightly.
- Peter-panning: reduce bias terms or depth-generator bias.
- Flicker/shimmer: verify texel snapping in cascade placement and avoid unstable blend ranges.
- Hard cascade seam: widen `shadowBlendStart`/`shadowBlendEnd` transition.
- Wrong light direction: validate star/planet vector conversion path before normalization.

### 4) Apply safe change protocol

When adding or renaming shadow uniforms:
1. Update uniforms list in `TerrainShader.create(...)`.
2. Update setter calls in `onBindObservable`.
3. Update GLSL uniform declarations and usage.
4. Verify both near and far paths are still symmetric.

When changing cascade behavior:
1. Keep near and far ranges monotonic (`far >= near * factor`).
2. Keep blend interval valid (`blendEnd > blendStart`).

## Validation

Run:

```powershell
./.codex/skills/world42-shadow-mapping/scripts/check-shadow-mapping-usage.ps1
npm run pw:validate
```

Report:
- command: `npm run pw:validate`
- status: pass or fail
- tested URL
- artifacts directory (`output/playwright/<runId>`)

## Resources

- Script: `scripts/check-shadow-mapping-usage.ps1`
- Reference: `references/shadow-mapping-world42.md`
