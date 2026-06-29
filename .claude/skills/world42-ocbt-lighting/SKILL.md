---
name: world42-ocbt-lighting
description: Analyze, tune, and evolve the OCBT lighting pipeline in World42. CDLOD is abandoned — this skill covers only the OCBT WebGPU path. Use when editing the OCBT fragment shader (terrain_render_material.ts), baked lighting constants, Lommel-Seeliger BRDF, Cook-Torrance specular, curvature AO, aerial fog, opposition surge, procedural albedo, ambient/light uniforms, tone-mapping consistency, or atmospheric scattering integration.
---

# World42 OCBT Lighting

CDLOD is abandoned. The only terrain rendering path is **OCBT** (pool-CBT, WebGPU/WGSL). All lighting work targets this path exclusively.

## Architecture at a glance

The OCBT fragment shader is **generated at runtime** in TypeScript — it is not a standalone `.wgsl` file. The full pipeline per frame:

```
terrain_render_material.ts (fragmentSource)
  └── bakedHeader()          → const TERRAIN_LIGHTCOLOR / TERRAIN_ALBEDO / TERRAIN_F0 / TERRAIN_AO_STRENGTH …
  └── terrain_f64.wgsl          → df64 primitives
  └── terrain_noise_df64.wgsl    → df64 noise + analytic gradients
  └── terrain_noise.wgsl (GPU)   → f32 FBM + simplex + terrainNoiseNormalAt
  └── fragment fn main()
        ├── terrainNoiseNormalAt()         per-pixel normal (f32 macro)
        ├── terrainNoiseNormalAt_df64()    near-ground normal (df64, cm-precise, gated)
        ├── terrainGroundAlbedo()          slope/altitude splatting → albedo
        ├── craterRays()               ejecta/halo brightness
        ├── Curvature AO               ao = 1 - TERRAIN_AO_STRENGTH * curvature  [bit3]
        ├── Lommel-Seeliger BRDF       ls = NdL/(NdL+NdV), blended with Lambert
        ├── Opposition surge           hotspot at low phase angle
        ├── Cook-Torrance specular     D·F·G (GGX NDF, Schlick F, Smith-GGX G)  [bit4]
        ├── Aerial fog                 exp(-uAtmoDensity * dist * altFactor)  [optional]
        └── final: albedo * (uAmbient * ao + TERRAIN_LIGHTCOLOR * uLightIntensity * refl)
              + TERRAIN_LIGHTCOLOR * uLightIntensity * spec
```

Post-processing is a Babylon 9 **Frame Graph** (`src/core/render/frame_graph.ts`) — NOT the old
`DefaultRenderingPipeline` (`postprocess_manager.ts` is now dead code). Pass order (HDR linear until the
tonemap task):

```
ObjectRenderer (terrain) → Star → Atmosphere* → TAA → Bloom → ImageProcessing (single ACES tonemap)
  → FXAA → Sharpen → GUI → backbuffer        (*Atmosphere task added only if a body has an atmosphere)
```

The Star and Atmosphere passes are custom `FrameGraphPostProcessTask`s with **native WGSL** fragment
shaders (migrated from GLSL — the whole project is WGSL now). Both output linear HDR.

## Key files

| File | Role |
|------|------|
| `src/systems/lod/terrain/gpu/terrain_render_material.ts` | **Central file**: shader source, baked constants, uniform bindings, `TerrainRenderOptions` |
| `src/systems/lod/terrain/gpu/terrain_source.ts` | Per-frame uniform updates (light dir, cam anchor, perf mask, intensity) |
| `src/systems/lod/terrain/terrain_scheduler.ts` | `TerrainPlanetOptions` type — source of `starIntensity`, `starColor`, `starPosWorldDouble`, `lighting` |
| `src/assets/shaders/terrain/engine/terrain_noise_df64.wgsl` | df64 noise + gradients (near-ground detail) |
| `src/assets/shaders/terrain/gpu/terrain_noise.wgsl` | f32 FBM/simplex used by both vertex and fragment |
| `src/assets/shaders/atmosphere/atmosphereFragmentShader.wgsl` | Atmosphere single-scattering post-process, **WGSL** (linear HDR out) |
| `src/assets/shaders/stars/starRayMarchingFragmentShader.wgsl` | Star glow post-process, **WGSL** (linear HDR out) |
| `src/core/render/frame_graph.ts` | Frame Graph render+post pipeline (ACES tonemap, bloom, FXAA, sharpen, TAA, star, atmosphere) |
| `src/game_world/stellar_system/data.json` | Star + planet catalogue — per-planet `lighting` overrides live here |
| `src/game_world/stellar_system/planet_lighting.json` | Global lighting `_defaults` (no per-planet blocks) |
| `src/game_world/stellar_system/planet_lighting.ts` | Types (`PlanetLightingParams`, `ResolvedLighting`), `DEFAULT_LIGHTING`, `resolveLighting()` |

## Uniform contract

Runtime uniforms (set per-frame via `TerrainRenderMaterial` interface):

| Uniform | Type | Set by | Default |
|---------|------|--------|---------|
| `uLightDirection` | vec3 | `setLightDirection()` — **planet-local** | (0,-1,0) |
| `uCamAnchor` | vec3 | `setCamAnchor()` — planet-local sim units | (0,0,0) |
| `uAmbient` | vec3 | `setAmbient()` | (0.008, 0.008, 0.008) |
| `uLightIntensity` | f32 | `setLightIntensity()` — from `starIntensity` | 1.0 |
| `uAtmoDensity` | f32 | `setAtmoDensity()` — 0 = disabled | 0 |
| `uAtmoColor` | vec3 | `setAtmoColor()` — fog target color | (0,0,0) |
| `uDebugLod` | i32 | `setDebugLod()` | 0 |
| `uPerfMask` | i32 | `setPerfMask()` | 0 |
| `world` | mat4 | Babylon auto-bind | identity |
| `viewProjection` | mat4 | Babylon auto-bind | — |
| `logarithmicDepthConstant` | f32 | `onBindObservable` | from camera.maxZ |

Baked constants (compiled into shader via `bakedHeader()` — changing requires material rebuild):

| Constant | Config field | Default |
|----------|-------------|---------|
| `TERRAIN_LIGHTCOLOR` | `TerrainRenderOptions.lightColor` | (1, 1, 1) |
| `TERRAIN_ALBEDO` / `TERRAIN_REGOLITH` / `TERRAIN_ROCK` | `lighting.albedo` | (0.15, 0.14, 0.13) |
| `TERRAIN_GROUND_ON_KM` / `TERRAIN_GROUND_OFF_KM` | `lighting.ground.onKm` / `offKm` | 0.05 / 0.15 |
| `TERRAIN_GROUND_STRENGTH` | `lighting.ground.strength` | 0.03 |
| `TERRAIN_GROUND_DETAIL_OCTAVES` | `lighting.ground.octaves` | 4 |
| `TERRAIN_HIGHLAND_TINT` | `lighting.terrain.highlandTint` | (1.12, 1.12, 1.16) |
| `TERRAIN_SLOPE_LO` / `TERRAIN_SLOPE_HI` / `TERRAIN_SLOPE_DIST` | `lighting.terrain.slope*` | 0.03 / 0.22 / 2.0 |
| `TERRAIN_PLAINS_AMP` | `lighting.terrain.plainsAmp` | 0.12 |
| `TERRAIN_LUNAR_LS` | `lighting.brdf.lunarLs` | 0.7 |
| `TERRAIN_OPP_AMP` / `TERRAIN_OPP_COS` | `lighting.brdf.oppAmp` / `oppCos` | 0.15 / 0.93 |
| `TERRAIN_AO_STRENGTH` | `lighting.brdf.aoStrength` | 0.35 |
| `TERRAIN_ROUGH_LO` / `TERRAIN_ROUGH_HI` | `lighting.brdf.roughLo` / `roughHi` | 0.6 / 0.9 |
| `TERRAIN_F0` | `lighting.brdf.f0` | 0.04 (dielectric rock) |
| `TERRAIN_SPEC_AA` / `TERRAIN_SPEC_MAX` | `lighting.brdf.specAa` / `specMax` | 0.5 / 4.0 |
| `TERRAIN_NORMAL_AA` | hardcoded in `bakedHeader()` (NOT in the lighting JSON) | 12.0 |
| `TERRAIN_GROUND_BASE_FREQ` | `opts.radius * 1000` (physical, not aesthetic) | — |

**Note**: `TERRAIN_AMBIENT` no longer exists — ambient is the runtime uniform `uAmbient`.
**Note**: `TERRAIN_AA_FOOTPRINT_KM` was REMOVED — the pixel footprint is now computed per-pixel
(`fpKm = max(length(dpdx(rel)), length(dpdy(rel)))`, `render_material:286`), not a hardcoded constant.
**Note**: `TERRAIN_NORMAL_FP_LO` / `TERRAIN_NORMAL_FP_HI` (the grazing-sun normal anti-alias band) live in the
**static** `terrain_noise.wgsl:286-287` (defaults 8.0 / 10.0), NOT in `bakedHeader()` — see Tuning recipes.

## Tuning recipes (symptom → knob)

Reach for the **first** matching row; later rows are secondary / last-resort. All of these are baked
(in `bakedHeader()` or the static `terrain_noise.wgsl`), so a **page reload** is enough to see the change —
no manual material rebuild.

> ⚠️ Judge every shading/aliasing change **by eye in a REAL browser**. Playwright/headless cannot show
> it faithfully: rAF is throttled to 30 fps and WebGPU timestamps are unavailable, so both the visual
> and `gpuMs` are unreliable there. Use the in-app perf HUD (**P** key) + `window.__world42Perf.setPerfMask(n)`.

| Symptom | Primary knob (location, default) | Direction | Trade-off |
|---|---|---|---|
| **Grazing-sun normal grain / sparkle** | `TERRAIN_NORMAL_FP_LO` / `TERRAIN_NORMAL_FP_HI` (`terrain_noise.wgsl:286-287`, 8.0 / 10.0) | **raise both** (e.g. 8→12 / 10→14) | softer / flatter micro-relief in the normal at the horizon |
| …residual normal grain anywhere | `TERRAIN_NORMAL_AA` (`terrain_render_material.ts:129`, 12.0) | **raise** (12→18) | over-flattens the foreground if pushed; can expose geometric sparkle far away |
| **Specular fireflies at low sun** | `TERRAIN_SPEC_AA` (0.5) ↑ or `TERRAIN_SPEC_MAX` (4.0) ↓ | raise AA / lower max | dimmer, softer glints |
| **Banding at the df64 ground fade** (~150 m alt) | `TERRAIN_GROUND_ON_KM` / `TERRAIN_GROUND_OFF_KM` (0.05 / 0.15) | widen the band | df64 detail engages later / over a longer range |
| Surface too flat (no relief shading) | `TERRAIN_LUNAR_LS` (0.7) | lower toward Lambert | loses the airless-disc (flat-lit) look |
| Whole surface too dark / too bright | `uAmbient` or `uLightIntensity` (runtime uniforms) | adjust | — |
| Crater floors not darker than plains | `TERRAIN_AO_STRENGTH` (0.35) | raise | crushes macro shading if too high |

**How the grazing-sun fix works (the #1 recipe):** the per-pixel footprint `fpKm =
max(length(dpdx(rel)), length(dpdy(rel)))` (`render_material:286`) blows up at grazing angles.
`terrainFbm_d_at(..., footprintKm)` then Nyquist-fades any fbm octave whose wavelength
`< footprintKm * TERRAIN_NORMAL_FP_LO` **out of the gradient only** — height and collision are untouched.
So fine octaves vanish from the SHADING normal exactly where they would alias. The same band gates
crater-rim aliasing (`terrain_noise.wgsl:180`). `TERRAIN_NORMAL_AA` (`render_material:327`) is the second,
screen-space stage: `mix(nSlope, nLocal, 1/(1 + TERRAIN_NORMAL_AA * nVar))` — blends toward the smooth slope
normal where the per-pixel normal varies fast. Note the inline `// wl < 2*footprint` comments in
`terrain_noise.wgsl` are stale; the live values are 8.0 / 10.0.

## Per-planet lighting config

All 18 config-driven baked constants (except `TERRAIN_NORMAL_AA` and `TERRAIN_GROUND_BASE_FREQ`, which are hardcoded) are read from a three-tier merge at material build time:

```
per-planet override  (data.json "lighting" block)
        ↓ ??
_defaults block      (planet_lighting.json)
        ↓ ??
DEFAULT_LIGHTING     (planet_lighting.ts — code fallback)
```

### How to tune a planet

Add or edit the `"lighting"` block in `data.json` under the planet entry. Only include what differs — all other fields fall back to `_defaults` → `DEFAULT_LIGHTING`:

```json
"Mars": {
  "type": "planet",
  "position_km": [...],
  "lighting": {
    "albedo":  [0.18, 0.09, 0.05],
    "terrain": { "slopeLo": 0.05 },
    "brdf":    { "lunarLs": 0.35, "roughLo": 0.65 }
  }
}
```

### How to change global defaults

Edit the `"_defaults"` block in `planet_lighting.json`. Applies to all planets without an override for that field.

### Data flow

```
data.json  body.lighting
     │
     ▼
loadStellarSystemFromCatalog()   → LoadedBody.lighting
     │
     ▼
createTerrainForSystem()
  resolveLighting(LIGHTING_JSON, body.lighting)  → ResolvedLighting
     │
     ▼
TerrainPlanet → TerrainSource → buildTerrainRenderMaterial()
  bakedHeader(opts)  reads opts.lighting for all 18 constants
```

### Types (planet_lighting.ts)

- `PlanetLightingParams` — all optional, for JSON overrides
- `ResolvedLighting` — all required (`Required<...>` deep), passed to `bakedHeader()`
- `DEFAULT_LIGHTING: ResolvedLighting` — code-level fallback (identical to previous hardcoded values)
- `resolveLighting(json, override?)` — merges `override ?? _defaults ?? DEFAULT_LIGHTING` per field

Valid range reminders:
- `brdf.f0`: [0.02, 0.07] — silicate 0.04, water-ice 0.022, sulfur 0.055
- `brdf.lunarLs`: 0 = Lambert, 1 = pure Lommel-Seeliger (airless disc)
- `terrain.highlandTint`: values > 1 brighten that RGB channel at altitude

## Coordinate space contract

- `uLightDirection`: **planet-local** (direction planet→star, negated in shader: `L = normalize(-uLightDirection)`).  
  Set via `Vector3.TransformNormalToRef(worldDir, invertedRenderParentMatrix, lightLocal)` in `terrain_source.ts` — no-op when `renderParent` has no rotation, correct when planet rotation is wired.
- `uCamAnchor`: **planet-local sim units** (same f32 value subtracted in the df64 EvaluateLEB pass)
- `nLocal`: planet-local surface normal from noise gradient
- `nWorld`: rotated to world-space via `(world * vec4(nLocal, 0)).xyz` — assumes uniform scale
- `rel` (varying `vRel`): camera-relative planet-local position (km, small f32-safe)
- `V`: view direction = `normalize(-(world * vec4(rel, 0)).xyz)` — surface-to-camera

## BRDF (current)

```wgsl
let NdL = max(dot(nWorld, L), 0.0);
let NdV = max(dot(nWorld, V), 1e-3);

// Lommel-Seeliger: models airless regolith (flat disc, no limb darkening)
let ls = NdL / (NdL + NdV);
var refl = mix(NdL, 2.0 * ls, TERRAIN_LUNAR_LS);   // 0=Lambert, 1=LS

// Opposition surge: hotspot when sun is behind camera (phase angle < ~20°)
let cosPhase = clamp(dot(V, L), -1.0, 1.0);
refl = refl * (1.0 + TERRAIN_OPP_AMP * smoothstep(TERRAIN_OPP_COS, 1.0, cosPhase));

// Cook-Torrance specular (D·F·G — energy conserving). Gated uPerfMask bit4.
let H = normalize(L + V);
let alpha = roughness * roughness;  // roughness = mix(ROUGH_LO, ROUGH_HI, slope01)
let D = alpha² / (π·(NdH²·(α⁴−1)+1)²)          // GGX NDF
let F = TERRAIN_F0 + (1−TERRAIN_F0)·(1−VdH)⁵             // Schlick Fresnel
let G = G1(NdL)·G1(NdV)  // Smith-GGX, k = alpha/2
spec = (D·F·G)/(4·NdL·NdV+ε) · NdL

// Curvature AO (macro-scale, from nSlope at TERRAIN_SLOPE_DIST km). Gated bit3.
let curvature = clamp(1.0 - dot(nSlope, dir), 0.0, 1.0);
let ao = 1.0 - TERRAIN_AO_STRENGTH * curvature;

let lighting = uAmbient * ao + TERRAIN_LIGHTCOLOR * (uLightIntensity * refl);
var finalColor = albedo * lighting + TERRAIN_LIGHTCOLOR * (uLightIntensity * spec);

// Aerial fog (optional, airless bodies only — not for full-atmosphere planets). uAtmoDensity=0 → disabled.
let fogFactor = exp(-uAtmoDensity * camDistKm * altFactor);  // altFactor = 0 above 1% radius
finalColor = mix(uAtmoColor, finalColor, fogFactor);
```

## uPerfMask bit map

| Bit | Block skipped when set |
|-----|----------------------|
| 0 | slope normal (`nSlope` — uses f32 macro instead) |
| 1 | df64 near-ground detail block |
| 2 | crater rays |
| 3 | curvature AO |
| 4 | Cook-Torrance specular |
| 6 (64) | zero the per-vertex crater gradient in the normals (visual A/B only — see note) |

> **Crater gradient is computed PER VERTEX, not per pixel.** `craterField` (6 size-classes × a
> 27-neighbor scan) is the dominant relief but **low-frequency** (cells ≥ 2 km), so the vertex shader
> evaluates it (`vCraterGrad` at the real per-vertex distance for the main/df64 normals;
> `vCraterGradSlope` at `TERRAIN_SLOPE_DIST` for the splat/AO normal) and the fragment reads the
> interpolated varyings. This measured **−55 % ground GPU power** (271→123 W on an RTX 5080, util
> 98→36 %) vs the old per-pixel scan, with no quality loss expected (low-freq → interpolates smoothly;
> shared edge verts → watertight). The high-frequency FBM detail **stays per-pixel** (that part DID
> facet when moved per-vertex — see [[ocbt-integration]] §4.2d). The fragment normals are built via
> `terrainNoiseNormalAtShared` / `terrainNoiseNormalAtShared_df64` (FBM per-pixel + crater varying) and
> `terrainNoiseNormalSlope` (macro FBM + slope crater varying). bit6 zeroes the crater term in shading for
> visual A/B; it no longer changes fragment compute (the crater now lives in the vertex).
>
> **Visual check after touching this:** fly ground→orbit and watch crater walls for triangle faceting
> (per-vertex normals faceted before; this is mitigated by moving only the low-freq crater, but verify).

## Workflow

### When editing the fragment shader

1. Edit `fragmentSource()` in `terrain_render_material.ts`.
2. If adding a uniform: add it to both the `uniforms: [...]` array in `buildTerrainRenderMaterial` AND call `material.set*()` with a default. Expose a setter on `TerrainRenderMaterial`.
3. If adding a baked constant: add it to `bakedHeader()` — the material must be rebuilt (dispose + recreate) to pick up new values.
4. Verify the dev server received the change: `curl -s http://localhost:19000/index.js | grep -c "<your-marker>"`.
5. Run `npm test` — the noise/df64 tests catch regressions in the normal computation.

### When tuning per-planet appearance

Edit the `"lighting"` block in `data.json` for that planet. The material is rebuilt once at scene load, so changing the JSON and reloading the page is enough — no code change needed.

To add a new planet config, just add a `"lighting": {}` block under the planet entry in `data.json`. Omitted fields fall back to `planet_lighting.json` `_defaults`.

### When tuning baked vs uniform

- **Baked constants** are zero-cost at runtime but require a full `ShaderMaterial` rebuild to change. Use for per-planet parameters set once at scene load. All 18 configurable constants are now driven by the `lighting` config system.
- **Uniforms** can be changed per-frame. Use for anything that changes at runtime (light direction, camera anchor, debug flags, fog density).
- Convert a baked constant to a uniform when: the parameter must animate per-frame OR must differ between planets without a material rebuild.

### When adding a new lighting feature

1. Check `references/ocbt-lighting-plan.md` — the feature may already have a design.
2. Verify `V`, `NdV`, `nWorld`, `nSlope`, `dir`, `altKm`, `camDistKm` are in scope (they all are in `fn main`).
3. Keep the `uPerfMask` pattern for any expensive new block (bits 0–4 are taken; use bit5+).
4. Do not add texture samplers without verifying WebGPU sampler-binding limits.
5. For aerial fog: use `uAtmoDensity` (set to 0 for atmosphere-post-process planets, >0 for dusty airless bodies).

## Validation

```bash
npm test               # CPU tests (noise + df64 + topology + planet_lighting) — must all pass
npm run serve          # dev server → http://localhost:19000
```

> ⚠️ **Perf + visual shading must be judged in a REAL (non-headless) browser.** Playwright/headless
> Chrome throttles rAF to a flat 30 fps and exposes no WebGPU timestamps, so `getStats().gpuMs` is
> garbage and aliasing/grain is not faithfully rendered. Playwright is fine for correctness, console
> errors and rough screenshots — not for perf or fine shading. In a real browser: **P** key toggles the
> perf HUD (working `gpuMs`); `window.__world42Perf.setPerfMask(n)` toggles cost blocks; first call
> `__world42Perf.enableCapture(true)` or the instrumentation counters read 0.

Visual checklist after lighting changes:
- [ ] Planet surface lit from the correct star direction
- [ ] No all-black or all-white surface (ambient + diffuse in valid range)
- [ ] Opposition surge visible when camera faces directly toward the sun
- [ ] Cook-Torrance glints visible at low sun angle on flat terrain (`__terrainPerfMask |= 16` to toggle)
- [ ] Crater floors slightly darker than flat plains (curvature AO — toggle bit3)
- [ ] LOD debug mode (`L` key / `uDebugLod=1`) still works (bypasses lighting)
- [ ] PerfMask bits still isolate cost correctly in GPU timer HUD
- [ ] No visible banding at the df64 ground-detail fade boundary (~150 m altitude)
- [ ] Bloom active on star halo (pipeline receives real HDR — not pre-clamped)
- [ ] AlphaCenA (intensity 1.2) visibly brighter than Sol (1.0)

## Resources

- Reference: `references/ocbt-lighting-plan.md` — improvement roadmap (rounds 1 & 2 complete, future axes listed)
