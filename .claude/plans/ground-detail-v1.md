# Ground Detail Rendering — Plan v1

**Branch:** CBT  
**Target body:** Moon (selena profile, Dev system)  
**Date:** 2026-06-30

---

## Context

The current terrain fragment shader renders albedo as two flat colors (`TERRAIN_REGOLITH` / `TERRAIN_ROCK`)
driven by slope alone (`terrainGroundAlbedo` in `terrain_render_material.ts`). Zero texture variation.
This is the main visual gap between World42 and reference-quality renderers (Elite Dangerous, SpaceEngine).

The geometry pipeline (OCBT + EvaluateLEB) is already excellent and unchanged by this plan.  
The render pipeline (Frame Graph, TAA, BRDF) is already final.  
Only the **fragment material layer** is being reworked.

### Inspirations

| Engine | What we borrow |
|---|---|
| SpaceEngine | Multi-scale texture sampling, procedural material selection |
| Orbiter 2016 | Distance LOD for texture (no sample > 100 km) |
| osgEarth | texture_2d_array PBR, height-based blending |
| Elite Dangerous | Visual target; implies stochastic tiling (zero visible repeat even on-foot) |
| Outerra | Regional geological variation concept → simplified to large-wavelength simplex first |

---

## UV Strategy

`dir` (planet-local unit vector, already in the positions buffer, already interpolated from VS)
is used as the UV basis. 1 sample per texture (not triplanar × 3).

- **Macro scale:** `dir * (radiusKm / 200.0)` — one tile covers ~200 km radius; drives material selection
- **Detail scale:** `dir * (radiusKm / 1.0)` — one tile covers ~1 km; active at camDistKm < ~50 km

These UVs are **floating-origin stable**: `dir` does not change when the camera origin resets.

### ⚠️ Seam mitigation (dominant-axis)

A hard dominant-axis projection creates visible seams at the 12 octahedron edges where
`|dir.x| ≈ |dir.y|` etc. — a single pixel flip switches axis and UV jumps.

**Fix: soft dominant-axis blend.** Weight each axis projection by how dominant it is:
```wgsl
fn softDominantUV(d: vec3<f32>) -> vec2<f32> {
    let a  = abs(d);
    let wx = pow(a.x, 8.0);
    let wy = pow(a.y, 8.0);
    let wz = pow(a.z, 8.0);
    let wsum = wx + wy + wz;
    let uvX = d.zy / (a.x + 1e-6);
    let uvY = d.xz / (a.y + 1e-6);
    let uvZ = d.xy / (a.z + 1e-6);
    return (uvX * wx + uvY * wy + uvZ * wz) / wsum;
}
```
The `pow(., 8)` sharpens the blend so each axis fully owns its pole while avoiding the hard seam.
Cost: 3 UV pairs computed, 2 extra lerps — negligible vs texture fetch cost. Still 1 texture sample.

---

## Step 0 — Perf Baseline ✅ DONE (2026-06-30)

**What:** Disable the fragment df64 block via `uPerfMask bit 1` and note FPS / GPU% delta on the perf HUD.

**Why:** The decision to remove fragment df64 in Step 4 is conditional on a real measured gain.
Without this baseline the removal is unjustified. 20 minutes of work, blocks Step 4.

**Files touched:** none — this is a runtime toggle via the options menu or `uPerfMask`.

### Results

Command: `node scripts/perf_probe.mjs --scenario ground-still --knob perfMask=0,2 --hwScale 0.5 --window 8`  
Conditions: Dev/Moon, ground-still (alt 60 m), hwScale 0.5 (supersample ×4 to break vsync cap), quality medium.

| | `perfMask=0` (df64 ON) | `perfMask=2` (df64 OFF) | Delta |
|---|---|---|---|
| GPU% med | 79 | 73 | **-6 pp** |
| GPU% p90 | 83 | 76 | **-7 pp** |
| GPU% max | 97 | 77 | **-20 pp** |
| Power | 193 W | 182 W | **-11 W (−5.7%)** |
| fps (uncapped) | 133 | 148 | +15 fps (+11%) |
| VRAM | 3221 MB | 3185 MB | −36 MB |
| leaves | 524 864 | 524 864 | ≡ |

**Key findings:**
- Fragment df64 costs ~6–8 GPU% points and ~11 W at ground level.
- Max spike 97→77%: the df64 branch diverges across fragments near `TERRAIN_GROUND_ON_KM`
  (some take df64 path, others don't within the same warp) — removal also eliminates the spike pattern.
- CPUrndr% = 101% on both runs: renderer main-thread is CPU-saturated at this hwScale; independent of df64.
- Step 4 (df64 removal) is **confirmed worthwhile** — proceed after Step 3 normal map compensates visually.

**Baseline to beat:** GPU% med **79** / Power **193 W** / fps **133** at ground, hwScale 0.5.

---

## Step 1 — Texture Arrays + Stochastic Tiling + Distance Fade

**The core step. All remaining steps depend on it.**

### Status ✅ DONE — completed 2026-07-01

The sketch below (manual `@binding(20)/(21)/(22)`, unresolved TypeScript API) is **superseded**:
BabylonJS 9.14 auto-assigns `@group/@binding` by scanning WGSL text; no manual numbers needed
(confirmed by reading `webgpuShaderProcessorsWGSL.pure.js`). See branch `feat/ground-detail-textures`.

**Done:**
- `tAlbedoHeight` texture_2d_array bound and working (`terrain_render_material.ts`, `samplers: ['tAlbedoHeight']`)
- Real material assets loaded from Poly Haven (CC0), 5 layers: regolith_fine, regolith_coarse,
  basalt_dark, ejecta_bright, rock_face — async load + hot-swap, cached per profileId
  (`terrain_material_asset_loader.ts`, `terrain_material_assets.ts`)
- `softDominantUV(d)` implemented exactly as sketched below — no seam
- Material weight selection (`terrainMaterialWeights(slope01)`: regolith/basalt/rock_face) implemented
- 2-material-max height blend implemented (using the albedo texture's alpha/height channel)
- `tNormalRoughness` now bound too — see Step 3 below (done 2026-07-01, same session)

**Also done (2026-07-01, second pass):**
- UV frequency calibrated: `TERRAIN_DETAIL_UV_FREQ` (~3 m/tile) + `TERRAIN_MACRO_UV_FREQ` (~500 m/tile,
  the former single-scale formula repurposed). Root cause derived precisely (see plan history) —
  the old formula was a reasonable MACRO scale mistakenly used as the only/detail scale.
- Stochastic tiling option A (per-cell hash rotate+offset, `terrainHash2D`/`stochasticSampleA`,
  built on the existing `terrainPermAt` table) — 0 extra texture samples, accepted cell-boundary seam.
- Detail→macro crossfade (`TERRAIN_DETAIL_FADE_ON/OFF_KM`, 20–60 km) replaces the flat-color-anchor
  idea entirely — no procedural color calibration needed, no pop.
- Diagnostic finding: the "flat grain" visual complaint is NOT from texture/UV/df64/shading-extras
  (all individually toggled off, no change) — it's the base geometric crater/regolith height field's
  diffuse shading contrast (sun-angle-dependent, camera-angle-independent, confirmed via nadir test).
  Real texture color variance exists (confirmed via direct GPU texture readback) but is subtle
  against this dominant shading contrast — expected for a low-contrast natural dirt photo.

**Remaining (deferred, not blocking):**
- Regolith_coarse / ejecta_bright (layers 1/3) still unused — no craterMaturity modulation yet
- Stochastic tiling option B (seamless 3-sample blend) — only if option A's seams prove objectionable

### 1a — Texture assets

`texture_2d_array`, RGBA8, two arrays:

| Array | Layers | Content |
|---|---|---|
| `tAlbedoHeight` | 5–6 | RGB = albedo, A = height (for blend) |
| `tNormalRoughness` | 5–6 | RG = normal XY, B = roughness, A = unused |

Layer index (selena/Moon):

| Index | Material |
|---|---|
| 0 | regolith_fine (flat plains, bright gray) |
| 1 | regolith_coarse (rough mare, darker) |
| 2 | basalt_dark (exposed rock, near-black) |
| 3 | ejecta_bright (fresh crater ejecta, high albedo) |
| 4 | rock_face (steep slopes, fractured rock) |

Textures must tile seamlessly and be small (256×256 or 512×512 per layer).

### 1b — Shader plumbing (`terrain_render_material.ts`)

**WGSL bindings** — add after the last existing binding (currently @binding(19) is `positions`):
```wgsl
@group(0) @binding(20) var tAlbedoHeight   : texture_2d_array<f32>;
@group(0) @binding(21) var tNormalRoughness: texture_2d_array<f32>;  // bound but unused until Step 3
@group(0) @binding(22) var sTerrainMat     : sampler;
```

**TypeScript side** — BabylonJS `ShaderMaterial` does not expose `texture_2d_array` via `setTexture`.
Use the raw WebGPU path on the underlying engine:
```typescript
// Create the array texture via BabylonJS RawTexture (internal WebGPU descriptor)
// or via engine._gl (WebGPU device) directly with:
//   device.createTexture({ size: [W, H, LAYERS], format: 'rgba8unorm',
//                          usage: GPUTextureUsage.TEXTURE_BINDING | COPY_DST,
//                          dimension: '2d' })
// Then bind to the ShaderMaterial via material.onBindObservable or
// material.setTexture + a custom BindingLayout override.
```
**Action before coding:** prototype the array texture bind in a scratch script to confirm the
BabylonJS 9.14 + ShaderMaterial path. The TextureManager (`core/io/`) handles KTX2; for array
textures a new helper `createTerrainArrayTexture(layers: HTMLImageElement[])` is likely needed.

**`tNormalRoughness` in Step 1:** bind a 1×1 stub texture `(0.5, 0.5, 1.0, 0)` (neutral normal,
no roughness) to satisfy WebGPU validation. Replaced by real data in Step 3.

### 1c — Fragment shader changes (`fragmentSource()`)

Replace `terrainGroundAlbedo(slope01, altKm)` with:

1. **Material weights** from existing `slope01`, `altKm`, `craterMaturity` (already computed):
   - w_rock_face   = smoothstep(0.4, 0.7, slope01)
   - w_basalt      = (1 - w_rock_face) * smoothstep(0.0, 0.2, slope01)
   - w_regolith    = 1 - w_rock_face - w_basalt   (plains, default)
   - crater modulates toward ejecta_bright / regolith_coarse

2. **UV computation** — soft dominant-axis projection (see UV Strategy above):
   ```wgsl
   let uvMacro  = softDominantUV(vDir) * (uRadius / 200.0);
   let uvDetail = softDominantUV(vDir) * (uRadius / 1.0);
   ```

3. **Stochastic tiling** on both UV sets:
   - Per-cell rotation (2×2 matrix, angle from `hash2(floor(uv))`)
   - Per-cell offset from same hash
   - Blend across 3 cells (or use Wang tiles if budget allows)

4. **Height blending — 2-material-max rule:**
   Take the two highest weights at each pixel; zero the rest. Then height-blend those two:
   ```wgsl
   // sort w_regolith, w_basalt, w_rock_face → pick top-2 as matA(wa) / matB(wb)
   let ha = textureSampleLevel(tAlbedoHeight, sTerrainMat, uvDetail, matA, 0.0).a + wa;
   let hb = textureSampleLevel(tAlbedoHeight, sTerrainMat, uvDetail, matB, 0.0).a + wb;
   let blend = saturate((ha - hb) / 0.1 + 0.5);   // rocks emerge from dust
   let albedo = mix(albedoB, albedoA, blend);
   ```
   This avoids undefined behaviour with 3-way height blending while keeping the visual intent.

5. **Distance fade + color anchor:**
   ```wgsl
   let texFade = 1.0 - smoothstep(50.0, 120.0, camDistKm);
   ```
   The procedural fallback colors `TERRAIN_REGOLITH` / `TERRAIN_ROCK` must be **manually calibrated**
   to match the average albedo of `regolith_fine` and `rock_face` textures respectively. This
   prevents a pop at the 120 km fade boundary. Calibrate after textures are authored.
   At detail scale: active only at camDistKm < 50 km.

**Files:** `terrain_render_material.ts`, `terrain_noise.wgsl` (add `dominantAxisUV`)

**Done when:** textures visible at ground level, no visible tiling at any range.

---

## Step 2 — Regional Variation (lightweight)

**What:** Add a single large-wavelength simplex (`~500 km` period) in the fragment to vary the
regolith/basalt blend weight regionally. This approximates the geological variation (maria vs terrae
on the Moon) without any texture-bake infrastructure.

```wgsl
let regionalBias = terrainSimplex3_d(vDir * TERRAIN_REGIONAL_FREQ).w * 0.3;
// w_basalt += regionalBias; w_regolith -= regionalBias;
```

`TERRAIN_REGIONAL_FREQ` is a baked constant — changing it requires "Apply" in the options menu.

**Why before control map:** 10 lines of WGSL, 80% of the regional variation benefit.
The Outerra-style control map (per-face RGBA8 bake) is only warranted if this proves insufficient
after visual evaluation.

**Files:** `terrain_render_material.ts` (baked header + fragment)

**Done when:** side-by-side comparison shows visibly different surface character between
crater basins and highland plains.

---

## Step 3 — Normal Map Perturbation

### Status ✅ DONE — completed 2026-07-01

The sketch below (`TERRAIN_NM_FADE_KM`, `NM_STRENGTH`, `dominantAxisRef`) is **superseded** by the
actual implementation, which reuses more existing infrastructure than originally planned:

- New `tNormalRoughness : texture_2d_array<f32>` binding + sampler, mirroring `tAlbedoHeight`
  exactly (placeholder → async hot-swap via the same generic `loadMaterialArrayTexture` loader,
  new `TERRAIN_NORMAL_ROUGHNESS_ASSET_MANIFEST` in `terrain_material_assets.ts`).
- Placeholder is a flat neutral tangent-space normal `(0,0,1)` + roughness alpha `127`
  (`mix(0.7,1.3,127/255) ≈ 1.0`, a no-op) — confirmed via `read_texture`: R=0.502, G=0.502,
  B=1.0, A=0.498, exactly as designed.
- Fade reuses the **existing** `TERRAIN_DETAIL_FADE_ON_KM`/`_OFF_KM` (from Step 1c's albedo
  macro-crossfade) instead of a new dedicated constant — one wavelength range for both the
  material texture AND its bump, which is simpler and avoids the "dedicated vs shared fade"
  ambiguity the original sketch worried about.
- Sample uses a **top-1** material pick (`layerN`, cheapest weight of `matW0`) rather than the
  full top-2 height-blend used for albedo — accepted simplification, negligible visually for
  isotropic ground bump.
- Applied via `normalize(mix(nLocal, tangent*x + bitangent*y + nLocal*z, bumpFade))`, matching the
  existing `nLocal = normalize(mix(nLocal, nDf, dFade))` idiom from the df64 block (not an ad-hoc
  additive perturbation) — placed right after the df64 block closes, so it stacks on top of it, and
  right before the grazing-angle normal-AA block, so that smoothing also catches the new bump for
  free.
- Roughness modulated by `mix(0.7, 1.3, nrSample.a)`, multiplied into the existing slope-driven
  `mix(TERRAIN_ROUGH_LO, TERRAIN_ROUGH_HI, slope01)` and clamped to `[0.05, 1]`.
- New `TERRAIN_NORMAL_MAP_STRENGTH` baked constant (default `0.6`), menu-tunable
  (`lighting.brdf.normalMapStrength`, `Lighting` group, following the `regionalAmp`/`roughLo`
  precedent).
- New `uPerfMask` bit7 (`128`) skips the block entirely — console A/B via
  `__world42Perf.setPerfMask(128)` vs `0`, matching the existing perf-flag convention.
- Two small hoists (`matW0`, `macroFade`, `uvDetail` moved earlier, no behavior change) so the
  normal/roughness pick can run before the BRDF roughness term needs the result — the duplicate
  computations further down were deleted, not left redundant.

**Verified:** `npm run build` exits 0; `npx vitest run` stays green (149/150, unaffected — pure
fragment-shading change, no geometry/collision impact); zero WebGPU validation errors; baked
`TERRAIN_NORMAL_MAP_STRENGTH = 0.6` confirmed via `get_draw_state`; placeholder texture read back
exactly neutral; missing asset files (none placed yet — see below) fail gracefully with a console
warning and the neutral placeholder stays bound, confirmed via the dev console; full-disc render
sanity-checked with the block active (mask=0) — no crash, no artifact, no regression vs Step 2's
maria/highlands look.

**Not yet done:** no real Poly Haven `nor_gl.png`/`rough.png` assets have been placed under
`public/assets/terrain/selena/` yet, so the actual bump is not visually confirmed — only the
plumbing (binding, fade, hoists, menu, perfMask toggle) is. The Poly Haven zips already downloaded
for Step 1's albedo/height ship these maps for the same materials; dropping them in
(`<material>_normal.png` / `<material>_roughness.png`) requires no further code changes — the
async loader will hot-swap them in automatically. Verify orientation once they land (flip the G
channel if bumps look like pits instead of raised grain).

---

## Step 4 — Remove Fragment df64 (conditional)

**Precondition:** Step 0 baseline shows ≥ measurable GPU gain at low altitude AND Step 3
normal map visually compensates the micro-relief.

**What:** Delete the `dFade`-gated fragment df64 block from `fragmentSource()`. Remove
`bit 1` from `uPerfMask` documentation. Remove the `df64_normalize` + extra FBM octaves.

**Note:** EvaluateLEB df64 (`terrain_topo_eval_leb_f64.compute.wgsl`) is **NOT** removed.
Compute cost is negligible vs fragment cost, and it protects geometry precision at
high/ultra quality presets (maxDepth 28–30). Only the fragment side is removed.

**Files:** `terrain_render_material.ts` (fragment only, baked header `uPerfMask` doc)

**Done when:** perf HUD GPU% at ground equals Step 0 baseline (with bit 1 disabled),
no visual regression vs Step 3 state.

---

## What This Plan Does NOT Change

- OCBT topology, EvaluateLEB, pool compaction, dispatch — untouched
- BRDF (Lommel-Seeliger + Cook-Torrance GGX) — untouched
- Crater geometry and analytical normals — untouched (they pilot the material weights)
- df64 EvaluateLEB compute — explicitly kept
- Frame Graph, TAA, FSR1, atmosphere — untouched
- Quality presets (`terrain_quality.ts`) — untouched

---

## Deferred (not in v1)

| Item | Reason deferred |
|---|---|
| Outerra control map (per-face RGBA8 bake) | Step 2 simplex likely sufficient; infrastructure cost high |
| Triplanar mapping | Direction-based UV is cheaper (1 sample vs 3) and sufficient for rocky bodies |
| Virtual texturing / megatexture | No tile cache (see memory: tile-cache-view-dependence.md) |
| Atmospheric scattering interaction with terrain albedo | Separate system; Moon has no atmosphere |
| Per-planet rotation in uLightDirection | Open roadmap item, independent of material |
| Step 2.5 — regional crater density (maria have fewer/smaller craters than highlands, resurfaced by lava) | More invasive than the Step 2 color fix: `craterField()` drives actual mesh geometry, not just fragment shading, and exists as synchronized copies in the fragment shader, the topology GPU compute kernel (`terrain_topology_kernel.ts`), and the CPU validation oracle (`terrain_noise.ts` + `terrain_cpu_mirror.ts`). Modulating crater existence (`rExist >= prm.w`) by `regionalBias` means threading the same bias into all 3-4 copies and keeping GPU/CPU bit-identical (the oracle must still match, or collision/tests break). Math is simple (one extra term in the existence check); the risk is purely in keeping the duplicated implementations in sync. Revisit after Step 3/4 (normal map, df64 removal) land.

---

## Review — Addressed Weak Points

| # | Issue | Resolution in plan |
|---|---|---|
| 1 | Dominant-axis UV seam at octahedron edges | `softDominantUV` — weighted blend of 3 projections via `pow(a, 8)` |
| 2 | TypeScript `texture_2d_array` API undefined | Documented: prototype first, new `createTerrainArrayTexture` helper likely needed |
| 3 | Normal map fade reused `dFade` (< 5 km) | Actually shipped: reuses `TERRAIN_DETAIL_FADE_ON/OFF_KM` (Step 1c's albedo crossfade, ~20-60 km) instead of a new dedicated constant — simpler, one fade range for the material texture and its bump |
| 4 | Height blend described for 2 materials, plan has 3+ | 2-material-max rule: pick top-2 weights per pixel, height-blend those only |
| 5 | Color pop at 120 km fade boundary | Calibrate `TERRAIN_REGOLITH/ROCK` baked constants to match texture average albedo |
| 6 | `tNormalRoughness` bound unused in Step 1 | Bind 1×1 neutral normal stub `(0.5, 0.5, 1.0, 0)` in Step 1; replaced by a real 5-layer array + async load in Step 3 (done) |

---

## Key Files

| File | Changes |
|---|---|
| `src/systems/lod/terrain/gpu/terrain_render_material.ts` | Main: bindings, bakedHeader, fragmentSource, vertexSource |
| `src/assets/shaders/terrain/gpu/terrain_noise.wgsl` | Add `dominantAxisUV()`, stochastic helpers |
| `src/assets/shaders/terrain/engine/terrain_render_material.ts` | baked constants: TERRAIN_REGIONAL_FREQ, NM_STRENGTH |
| New texture assets | 5–6 × 2 RGBA8 PNG/KTX2 in `src/assets/textures/terrain/selena/` |
