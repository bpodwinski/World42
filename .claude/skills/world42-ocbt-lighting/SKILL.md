---
name: world42-ocbt-lighting
description: Analyze, tune, and evolve the OCBT lighting pipeline in World42. CDLOD is abandoned — this skill covers only the OCBT WebGPU path. Use when editing the OCBT fragment shader (ocbt_render_material.ts), baked lighting constants, Lommel-Seeliger BRDF, opposition surge, procedural albedo, ambient/light uniforms, tone-mapping consistency, specular additions, self-shadow/AO, or atmospheric scattering integration.
---

# World42 OCBT Lighting

CDLOD is abandoned. The only terrain rendering path is **OCBT** (pool-CBT, WebGPU/WGSL). All lighting work targets this path exclusively.

## Architecture at a glance

The OCBT fragment shader is **generated at runtime** in TypeScript — it is not a standalone `.wgsl` file. The full pipeline per frame:

```
ocbt_render_material.ts (fragmentSource)
  └── bakedHeader()          → const CBT_AMBIENT / CBT_LIGHTCOLOR / CBT_ALBEDO …
  └── ocbt_f64.wgsl          → df64 primitives
  └── cbt_noise_df64.wgsl    → df64 noise + analytic gradients
  └── cbt_noise.wgsl (GPU)   → f32 FBM + simplex + cbtNoiseNormalAt
  └── fragment fn main()
        ├── cbtNoiseNormalAt()         per-pixel normal (f32 macro)
        ├── cbtNoiseNormalAt_df64()    near-ground normal (df64, cm-precise, gated)
        ├── cbtGroundAlbedo()          slope/altitude splatting → albedo
        ├── craterRays()               ejecta/halo brightness
        ├── Lommel-Seeliger BRDF       ls = NdL/(NdL+NdV)
        ├── Opposition surge           hotspot at low phase angle
        └── final: albedo * (CBT_AMBIENT + CBT_LIGHTCOLOR * refl)
```

Post-processing layered on top (not in OCBT shader):
- `atmosphericScatteringFragmentShader.glsl` — Rayleigh + Mie + ozone, ACES tone-map
- `starRayMarchingFragmentShader.glsl` — SDF star glow, Reinhard
- Babylon DefaultRenderingPipeline — Reinhard tone-map, bloom, FXAA, sharpen

## Key files

| File | Role |
|------|------|
| `src/systems/lod/cbt/ocbt/ocbt_render_material.ts` | **Central file**: shader source, baked constants, uniform bindings, `OcbtRenderOptions` |
| `src/assets/shaders/cbt/ocbt/cbt_noise_df64.wgsl` | df64 noise + gradients (near-ground detail) |
| `src/assets/shaders/cbt/gpu/cbt_noise.wgsl` | f32 FBM/simplex used by both vertex and fragment |
| `src/assets/shaders/atmosphericScatteringFragmentShader.glsl` | Atmosphere post-process |
| `src/assets/shaders/stars/starRayMarchingFragmentShader.glsl` | Star glow post-process |
| `src/core/render/postprocess_manager.ts` | Babylon pipeline (tone-map, bloom, FXAA) |
| `src/app/setup_lod_and_shadows.ts` | Per-frame light direction + shadow cascade update |
| `src/systems/lod/cbt/ocbt/ocbt_topology_kernel.ts` | OCBT tick driver (calls `setLightDirection`) |
| `src/game_world/stellar_system/data.json` | Star catalogue: `intensity`, `color_rgb`, `temperature_k` |

## Uniform contract

Runtime uniforms (set per-frame via `OcbtRenderMaterial` interface):

| Uniform | Type | Set by | Default |
|---------|------|--------|---------|
| `uLightDirection` | vec3 | `ocbt_render_material.setLightDirection()` | (0,-1,0) |
| `uCamAnchor` | vec3 | `ocbt_render_material.setCamAnchor()` | (0,0,0) |
| `uDebugLod` | i32 | `ocbt_render_material.setDebugLod()` | 0 |
| `uPerfMask` | i32 | `ocbt_render_material.setPerfMask()` | 0 |
| `world` | mat4 | Babylon auto-bind | identity |
| `viewProjection` | mat4 | Babylon auto-bind | — |
| `logarithmicDepthConstant` | f32 | `onBindObservable` | from camera.maxZ |

Baked constants (compiled into shader via `bakedHeader()` — changing requires material rebuild):

| Constant | Source | Default |
|----------|--------|---------|
| `CBT_AMBIENT` | `OcbtRenderOptions.ambient` | (0.008, 0.008, 0.008) |
| `CBT_LIGHTCOLOR` | `OcbtRenderOptions.lightColor` | (1, 1, 1) |
| `CBT_ALBEDO` | `OcbtRenderOptions.albedo` | (0.15, 0.14, 0.13) |
| `CBT_LUNAR_LS` | hardcoded | 0.7 |
| `CBT_OPP_AMP` | hardcoded | 0.15 |
| `CBT_OPP_COS` | hardcoded | 0.93 |

## Coordinate space contract

- `uLightDirection`: **planet-local** (points planet→star, negated in shader: `L = normalize(-uLightDirection)`)
- `uCamAnchor`: **planet-local sim units** (same f32 value subtracted in the df64 EvaluateLEB pass)
- `nLocal`: planet-local surface normal from noise gradient
- `nWorld`: rotated to world-space via `(world * vec4(nLocal, 0)).xyz` — assumes uniform scale
- `rel` (varying `vRel`): camera-relative planet-local position (km, small f32-safe)
- `V`: view direction = `normalize(-(world * vec4(rel, 0)).xyz)` — surface-to-camera

## BRDF

```wgsl
let NdL = max(dot(nWorld, L), 0.0);
let NdV = max(dot(nWorld, V), 1e-3);

// Lommel-Seeliger: models airless regolith (flat disc, no limb darkening)
let ls = NdL / (NdL + NdV);
var refl = mix(NdL, 2.0 * ls, CBT_LUNAR_LS);   // 0=Lambert, 1=Lommel-Seeliger

// Opposition surge: hotspot when sun is behind camera (phase angle < ~20°)
let cosPhase = clamp(dot(V, L), -1.0, 1.0);
refl = refl * (1.0 + CBT_OPP_AMP * smoothstep(CBT_OPP_COS, 1.0, cosPhase));

let lighting = CBT_AMBIENT + CBT_LIGHTCOLOR * refl;
```

## Workflow

### When editing the fragment shader

1. Edit `fragmentSource()` in `ocbt_render_material.ts`.
2. If adding a uniform: add it to both the `uniforms: [...]` array in `buildOcbtRenderMaterial` AND call `material.set*()` with a default.
3. If adding a baked constant: add it to `bakedHeader()` — note the material must be rebuilt (dispose + recreate) to pick up new baked values.
4. Verify the dev server received the change: `curl -s http://localhost:19000/index.js | grep -c "<your-marker>"`.
5. Run `npm test` — the noise/df64 tests catch regressions in the normal computation.

### When tuning baked vs uniform

- **Baked constants** are zero-cost at runtime but require a full `ShaderMaterial` rebuild to change. Appropriate for per-planet parameters set once at scene load.
- **Uniforms** can be changed per-frame. Appropriate for anything that changes at runtime (light direction, camera anchor, debug flags).
- Convert a baked constant to a uniform when: the parameter must animate per-frame OR must differ between planets without a material rebuild.

### When adding a new lighting feature

1. Check `references/ocbt-lighting-plan.md` — the feature may already have a design.
2. Verify V is available in scope if the feature needs it (it is: `let V = normalize(-(uniforms.world * vec4<f32>(rel, 0.0)).xyz)`).
3. Keep the `uPerfMask` pattern for any expensive new block (`bit0`, `bit1`, `bit2` are taken; use `bit3` onward).
4. Do not add texture samplers without verifying WebGPU sampler-binding limits.

## Validation

```bash
npm test               # noise + df64 unit tests (149 tests + cross-check)
npm run serve          # dev server → http://localhost:19000
```

Visual checklist after lighting changes:
- [ ] Planet surface lit from the correct star direction
- [ ] No all-black or all-white surface (ambient + diffuse in valid range)
- [ ] Opposition surge visible when camera faces directly toward the sun
- [ ] LOD debug mode (`L` key / `uDebugLod=1`) still works (bypasses lighting)
- [ ] PerfMask bits still isolate cost correctly in GPU timer HUD
- [ ] No visible banding at the df64 ground-detail fade boundary (~150 m altitude)

## Resources

- Reference: `references/ocbt-lighting-plan.md` — improvement roadmap with implementation design
