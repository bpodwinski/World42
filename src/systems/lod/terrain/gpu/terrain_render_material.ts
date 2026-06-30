/**
 * TERRAIN render material (WebGPU, WGSL) — the pool-TERRAIN twin of
 * gpu_terrain_render_material.ts. The mesh is implicit: a 3-vertex template drawn once
 * per pool slot (`forcedInstanceCount = capacity`). The vertex shader reads the
 * per-slot heap id (to skip dead slots) and the EvaluateLEB positions buffer (3
 * unit-dir corners per slot, decoded on the GPU in terrain_topo_eval_leb.compute.wgsl),
 * picks corner `vertexIndex`, displaces it radially by the fbm height, and projects.
 * The fragment shader recomputes the per-pixel normal from the analytic noise
 * gradient — identical to the implicit-TERRAIN material, so shading matches the rest of
 * the terrain. No CPU geometry, no per-frame upload.
 *
 * Decode convention: the positions buffer is produced by terrain_eval_leb.wgsl (the
 * REFERENCE leb convention over the consistently-wound octahedron), so this material
 * never touches the legacy terrain_leb decode.
 */
import {
    Mesh,
    ShaderLanguage,
    ShaderMaterial,
    StorageBuffer,
    VertexData,
    Vector3,
    Constants,
    type BaseTexture,
    type Scene,
    type StorageBuffer as StorageBufferType,
    type WebGPUEngine
} from '@babylonjs/core';
import {
    buildPerm,
    craterHeaderWgsl,
    DEFAULT_CRATERS,
    type CraterParams,
    type NoiseParams
} from '../terrain_noise';
import { DEFAULT_LIGHTING, type ResolvedLighting } from '../../../../game_world/stellar_system/planet_lighting';
import { slotStateWgslPreamble } from './terrain_engine_buffers';
import terrainNoiseWgsl from '../../../../assets/shaders/terrain/gpu/terrain_noise.wgsl';
import terrainF64Wgsl from '../../../../assets/shaders/terrain/engine/terrain_f64.wgsl';
import terrainNoiseDf64Wgsl from '../../../../assets/shaders/terrain/engine/terrain_noise_df64.wgsl';

/** WGSL f32 literal (always has a decimal point). */
function f(x: number): string {
    return Number.isInteger(x) ? `${x}.0` : `${x}`;
}

export type TerrainRenderOptions = {
    radius: number;
    noise: NoiseParams;
    /** Crater field — baked into the WGSL header AND used by CPU collision. Default DEFAULT_CRATERS. */
    craters?: CraterParams;
    albedo?: Vector3;
    ambient?: Vector3;
    lightColor?: Vector3;
    lightIntensity?: number;
    atmoDensity?: number;
    atmoColor?: Vector3;
    /** Per-planet resolved lighting params. When absent, bakedHeader uses DEFAULT_LIGHTING. */
    lighting?: ResolvedLighting;
};

export function bakedHeader(opts: TerrainRenderOptions): string {
    const n = opts.noise;
    const L = opts.lighting ?? DEFAULT_LIGHTING;
    const g = L.ground;
    const t = L.terrain;
    const b = L.brdf;
    const albedo = opts.albedo ?? new Vector3(L.albedo[0], L.albedo[1], L.albedo[2]);
    const lightColor = opts.lightColor ?? new Vector3(1, 1, 1);
    return [
        `const TERRAIN_RADIUS : f32 = ${f(opts.radius)};`,
        `const TERRAIN_OCTAVES : i32 = ${Math.max(0, Math.floor(n.octaves))};`,
        `const TERRAIN_BASE_FREQ : f32 = ${f(n.baseFrequency)};`,
        `const TERRAIN_BASE_AMP : f32 = ${f(n.baseAmplitude)};`,
        `const TERRAIN_LACUNARITY : f32 = ${f(n.lacunarity)};`,
        `const TERRAIN_PERSISTENCE : f32 = ${f(n.persistence)};`,
        `const TERRAIN_GLOBAL_AMP : f32 = ${f(n.globalAmplitude)};`,
        `const TERRAIN_DETAIL_OCTAVES : i32 = ${Math.max(0, Math.floor(n.detailOctaves ?? 0))};`,
        `const TERRAIN_DETAIL_RANGE : f32 = ${f(n.detailRange ?? 60)};`,
        // Crater constants + craterParams() — generated from the active CraterParams (single source
        // shared with the CPU collision field). Replaces the block formerly hardcoded in terrain_noise.wgsl.
        craterHeaderWgsl(opts.craters ?? DEFAULT_CRATERS),
        `const TERRAIN_ALBEDO : vec3<f32> = vec3<f32>(${f(albedo.x)}, ${f(albedo.y)}, ${f(albedo.z)});`,
        `const TERRAIN_LIGHTCOLOR : vec3<f32> = vec3<f32>(${f(lightColor.x)}, ${f(lightColor.y)}, ${f(lightColor.z)});`,
        // Near-ground detail band (world-anchored df64 micro-relief). ON/OFF in km = the
        // camera-distance fade; STRENGTH = normal-tilt amount; BASE_FREQ = first ground
        // octave's frequency on the UNIT dir (= radius / wavelength; 1 m base wavelength).
        `const TERRAIN_GROUND_ON_KM : f32 = ${f(g.onKm)};`,
        `const TERRAIN_GROUND_OFF_KM : f32 = ${f(g.offKm)};`,
        `const TERRAIN_GROUND_STRENGTH : f32 = ${f(g.strength)};`,
        `const TERRAIN_GROUND_DETAIL_OCTAVES : i32 = ${Math.max(0, Math.floor(g.octaves))};`,
        `const TERRAIN_GROUND_BASE_FREQ : f32 = ${f(opts.radius * 1000)};`,
        // Atlas tile-cache magnification gate (atlas texels per screen pixel). A tile is baked
        // at its own texel footprint (~edge/64); when the screen pixel footprint is FINER than
        // that (texPerPx < 1, the magnified/close regime) the live per-pixel path resolves more
        // relief than the tile holds, so the cache reads as flat facets. Below this the fragment
        // uses the live path; at texPerPx == 1 the tile is 1:1 (same footprint) so the handoff is
        // seamless. Above it the coarse-mip blend handles minification. (Replaces the old minif
        // gate, which had the comparison inverted and used the atlas exactly where it under-resolves.)
        `const TERRAIN_TILE_MAG_GATE : f32 = ${f(1.0)};`,
        // Procedural albedo splatting driven by SLOPE + ALTITUDE (physically meaningful, not
        // random color blotches): REGOLITH on flats, darker greyer ROCK on slopes, HIGHLAND
        // tint by altitude. Slope is read from the SMOOTH landform normal (TERRAIN_SLOPE_DIST
        // fades the cm micro-relief out so rock follows 30m+ hills/crater walls, not per-pixel
        // bumps). SLOPE_* are in slope units = 1 - dot(landformNormal, up); 0 = flat.
        ...(() => {
            const gv = (albedo.x + albedo.y + albedo.z) / 3;
            const rk = (c: number) => 0.45 * (0.5 * c + 0.5 * gv); // darker + desaturated
            return [
                `const TERRAIN_REGOLITH : vec3<f32> = vec3<f32>(${f(albedo.x)}, ${f(albedo.y)}, ${f(albedo.z)});`,
                `const TERRAIN_ROCK : vec3<f32> = vec3<f32>(${f(rk(albedo.x))}, ${f(rk(albedo.y))}, ${f(rk(albedo.z))});`
            ];
        })(),
        `const TERRAIN_HIGHLAND_TINT : vec3<f32> = vec3<f32>(${f(t.highlandTint[0])}, ${f(t.highlandTint[1])}, ${f(t.highlandTint[2])});`,
        `const TERRAIN_SLOPE_LO : f32 = ${f(t.slopeLo)};`,
        `const TERRAIN_SLOPE_HI : f32 = ${f(t.slopeHi)};`,
        `const TERRAIN_SLOPE_DIST : f32 = ${f(t.slopeDist)};`,
        `const TERRAIN_ALT_LO : f32 = ${f(opts.noise.globalAmplitude * 0.25)};`,
        `const TERRAIN_ALT_HI : f32 = ${f(opts.noise.globalAmplitude * 0.65)};`,
        // Smooth plains vs cratered highlands: a BROAD (continental ~400 km), SUBTLE brightness
        // variation so the surface isn't uniform — NOT the fine blotches. dir-based (no swim).
        `const TERRAIN_PLAINS_FREQ : f32 = ${f(opts.radius / 400)};`,
        `const TERRAIN_PLAINS_AMP : f32 = ${f(t.plainsAmp)};`,
        // Lunar (airless-regolith) BRDF. TERRAIN_LUNAR_LS blends Lambert (0) <-> Lommel-Seeliger (1):
        // the regolith reflects flat, with NO limb darkening (a full Moon looks like a uniform
        // disc, not a shaded sphere) and slight limb BRIGHTENING. TERRAIN_OPP_* is the opposition
        // surge (hotspot when the Sun is at the camera's back, low phase angle).
        `const TERRAIN_LUNAR_LS : f32 = ${f(b.lunarLs)};`,
        `const TERRAIN_OPP_AMP : f32 = ${f(b.oppAmp)};`,
        `const TERRAIN_OPP_COS : f32 = ${f(b.oppCos)};`,
        // Curvature AO: ambient occlusion from deviation of terrain normal vs radial direction.
        // Applied to ambient only. Computed from nSlope (smooth normal) for macro-scale AO.
        `const TERRAIN_AO_STRENGTH : f32 = ${f(b.aoStrength)};`,
        // Cook-Torrance specular. Slope-driven roughness (flat=smoother, steep=matte).
        // TERRAIN_F0 is Fresnel at normal incidence (~0.04 for dielectric rock/regolith).
        // Regolith is MATTE (Moon/Mercury) — a high roughness floor gives a broad, dim sheen
        // instead of a sharp glossy lobe that blotches/sparkles on every micro-bump toward the Sun.
        `const TERRAIN_ROUGH_LO : f32 = ${f(b.roughLo)};`,
        `const TERRAIN_ROUGH_HI : f32 = ${f(b.roughHi)};`,
        `const TERRAIN_F0 : f32 = ${f(b.f0)};`,
        // Geometric specular antialiasing: scales the screen-space normal variance added to
        // roughness^2. Higher = more de-sparkle (softer highlight under micro-relief / at grazing).
        `const TERRAIN_SPEC_AA : f32 = ${f(b.specAa)};`,
        // Firefly clamp on the specular term (caps blown-out grazing pixels).
        `const TERRAIN_SPEC_MAX : f32 = ${f(b.specMax)};`,
        // Diffuse normal antialiasing: where the per-pixel shading normal varies faster than the
        // pixel can resolve (fine foreground micro-relief), blend toward the smooth landform normal
        // so the diffuse ndl stops aliasing into grain. Variance-based (dpdx of the normal) so it
        // targets sub-pixel detail without over-flattening the far field. Higher = smoother sooner.
        `const TERRAIN_NORMAL_AA : f32 = ${f(b.normalAa)};`,
        // Mean-preserving normal-AA correction strength (uPerfMask bit5). The variance-smoothed normal
        // over-brightens at grazing because the BRDF is concave there (Jensen: E[f(N)] < f(E[N])); this
        // darkens the diffuse by the sub-pixel normal variance × grazing concavity to restore the mean.
        `const TERRAIN_MEAN_AA_K : f32 = ${f(b.meanAaK)};`,
        // Per-vertex crater-gradient footprint scale. The crater gradient is evaluated PER VERTEX and
        // interpolated across the leaf; a crater smaller than the leaf can't be represented and aliases
        // to the leaf shape (square/diamond facets at distance). footprintKm = camDistKm * K approximates
        // the leaf edge (the LOD keeps leaf ~constant screen-px, so leaf size ∝ distance), feeding the
        // craterField Nyquist fade (crFp) so sub-leaf craters smoothly fade instead of squaring. K≈leaf
        // angular size / (TERRAIN_NORMAL_FP_LO). camDistKm is shared at edge verts → stays watertight.
        `const TERRAIN_CRATER_FP_K : f32 = ${f(b.craterFpK)};`,
    ].flat().join('\n');
}

function vertexSource(opts: TerrainRenderOptions): string {
    return [
        bakedHeader(opts),
        'var<storage, read> terrainHeap : array<u32>;', // 2 u32/slot (u64 lo,hi)
        'var<storage, read> terrainPos : array<f32>;', // 18 f32/slot: per corner [relative.xyz, dir.xyz]
        'var<storage, read> terrainIndices : array<u32>;', // compacted live-slot list
        'var<storage, read> terrainPerm : array<u32>;',
        terrainNoiseWgsl,
        // Camera-relative path (Phase 3): the EvaluateLEB pass already produced each
        // corner CAMERA-RELATIVE in df64 then narrowed, so the per-vertex magnitude is
        // small and precise. renderPos = mat3(world) * relative (the planet-center->camera
        // translation cancels exactly: T_render = -R*camLocal, so R*localPos + T_render =
        // R*(localPos - camLocal) = R*relative). We therefore need viewProjection + the
        // world ROTATION/SCALE only, NOT worldViewProjection (which re-adds the big offset).
        'uniform viewProjection : mat4x4<f32>;',
        'uniform world : mat4x4<f32>;',
        // Per-frame residual camera drift (planet-local): anchorCamLocal - liveCamLocal. The baked
        // localRel is camera-relative to a FROZEN anchor; adding this delta makes the rendered
        // position exact for the LIVE camera without re-running the EvaluateLEB noise (see TerrainSource).
        'uniform uCamDelta : vec3<f32>;',
        'uniform logarithmicDepthConstant : f32;',
        'varying vDir : vec3<f32>;',
        'varying vRel : vec3<f32>;',
        'varying vFragmentDepth : f32;',
        'varying vLevel : f32;',
        // Crater gradient (dominant, LOW-FREQUENCY relief) evaluated PER VERTEX + interpolated, instead
        // of re-scanning the 6x27 crater field per pixel in each normal. vCraterGrad: real per-vertex
        // camera distance (main + df64 normals); vCraterGradSlope: TERRAIN_SLOPE_DIST (smooth splat/AO).
        'varying vCraterGrad : vec3<f32>;',
        'varying vCraterGradSlope : vec3<f32>;',
        // Macro fbm gradient for the SMOOTH slope/AO normal, evaluated PER VERTEX (was a 2nd per-pixel
        // 8-octave fbm in terrainNoiseNormalSlope ~21W). Read back in the fragment via terrainNormalFromGrad.
        'varying vSlopeFbmGrad : vec3<f32>;',
        // Tile-cache fast path: per-corner barycentric coord (1,0,0)/(0,1,0)/(0,0,1) for atlas UV
        // reconstruction; slot index so the fragment can look up the per-slot slotState word.
        'varying vBary    : vec3<f32>;',
        'varying vSlotIdx : f32;',
        'attribute position : vec3<f32>;',
        '@vertex',
        'fn main(input : VertexInputs) -> FragmentInputs {',
        '    // Compacted draw: instance i -> live slot. The over-estimated forcedInstanceCount',
        '    // may index a stale tail entry (now-dead slot) -> the heap-id-0 gate degenerates it.',
        '    let slot = terrainIndices[vertexInputs.instanceIndex];',
        '    let lo = terrainHeap[slot * 2u];',
        '    let hi = terrainHeap[slot * 2u + 1u];',
        '    // Dead pool slot (heap id 0): collapse to a clipped degenerate triangle.',
        '    if (lo == 0u && hi == 0u) {',
        '        vertexOutputs.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);',
        '        vertexOutputs.vDir = vec3<f32>(0.0, 1.0, 0.0);',
        '        vertexOutputs.vRel = vec3<f32>(0.0, 0.0, 0.0);',
        '        vertexOutputs.vFragmentDepth = 1.0;',
        '        vertexOutputs.vLevel = 0.0;',
        '        vertexOutputs.vCraterGrad = vec3<f32>(0.0);',
        '        vertexOutputs.vCraterGradSlope = vec3<f32>(0.0);',
        '        vertexOutputs.vSlopeFbmGrad = vec3<f32>(0.0);',
        '        vertexOutputs.vBary    = vec3<f32>(0.0);',
        '        vertexOutputs.vSlotIdx = 0.0;',
        '        return vertexOutputs;',
        '    }',
        '    let vi = vertexInputs.vertexIndex;',
        '    let base = slot * 18u + vi * 6u;',
        '    // rel is already the TERRAIN-displaced camera-relative position (the df64',
        '    // EvaluateLEB pass adds the fbm height now, so the topology metric/frustum stay',
        '    // terrain-aware). The VS just projects it; dir is kept for the fragment normal.',
        '    let localRel = vec3<f32>(terrainPos[base], terrainPos[base + 1u], terrainPos[base + 2u]);',
        '    let dir = vec3<f32>(terrainPos[base + 3u], terrainPos[base + 4u], terrainPos[base + 5u]);',
        '    let R = mat3x3<f32>(uniforms.world[0].xyz, uniforms.world[1].xyz, uniforms.world[2].xyz);',
        '    // localRel is camera-relative to the frozen anchor; uCamDelta = anchorCamLocal - liveCamLocal',
        '    // re-bases it to the live camera: R*(localRel + uCamDelta) = R*(localPos - liveCamLocal).',
        '    let renderPos = R * (localRel + uniforms.uCamDelta);',
        '    vertexOutputs.position = uniforms.viewProjection * vec4<f32>(renderPos, 1.0);',
        '    // Hand-written WGSL ShaderMaterial: Babylon does NOT auto-inject the WebGPU',
        '    // NDC-Y flip (it does for transpiled GLSL), so flip clip-space Y to match',
        '    // the worker/GLSL terrain (otherwise the planet renders upside-down).',
        '    vertexOutputs.position.y = -vertexOutputs.position.y;',
        '    vertexOutputs.vDir = dir;',
        '    // Camera-relative position (sim units = km): its length is the per-vertex',
        '    // distance to camera that drives the detail-octave fade in the fragment normal.',
        '    vertexOutputs.vRel = localRel;',
        '    // Per-vertex crater gradient (the dominant, LOW-FREQUENCY relief): evaluated here and',
        '    // interpolated instead of re-scanning the 6x27 crater field per pixel in each normal.',
        '    // Same per-vertex camera distance the fragment uses; shared edge vertices have identical',
        '    // dir + distance, so the interpolated gradient is watertight (no shading seam). Slope',
        '    // variant at TERRAIN_SLOPE_DIST feeds the smooth splat/AO normal (stable across altitude).',
        '    let camDistKmV = length(localRel + uniforms.uCamDelta);',
        '    // Leaf-size footprint (camDistKm * K) feeds the craterField Nyquist fade so sub-leaf craters',
        '    // fade out instead of aliasing to square/diamond leaf facets at distance (per-vertex interp).',
        '    let craterFpKm = camDistKmV * TERRAIN_CRATER_FP_K;',
        '    vertexOutputs.vCraterGrad = craterField(dir, TERRAIN_RADIUS, camDistKmV, true, craterFpKm).yzw;',
        '    vertexOutputs.vCraterGradSlope = craterField(dir, TERRAIN_RADIUS, TERRAIN_SLOPE_DIST, true, craterFpKm).yzw;',
        '    // Macro fbm gradient for the smooth slope/AO normal at the fixed TERRAIN_SLOPE_DIST footprint:',
        '    // evaluated here (per vertex) instead of a 2nd per-pixel 8-octave fbm. Low-frequency, so the',
        '    // interpolation is watertight (shared edge verts share dir); the fragment only projects it.',
        '    vertexOutputs.vSlopeFbmGrad = terrainFbmGradAt_core(normalize(dir), TERRAIN_SLOPE_DIST, TERRAIN_RADIUS, 0.0, true);',
        '    // Tree depth = firstLeadingBit(heap); faces are depth 3 => level = depth - 3.',
        '    var depth : u32;',
        '    if (hi != 0u) { depth = 32u + firstLeadingBit(hi); } else { depth = firstLeadingBit(lo); }',
        '    vertexOutputs.vLevel = f32(depth) - 3.0;',
        '    vertexOutputs.vFragmentDepth = 1.0 + vertexOutputs.position.w;',
        '    vertexOutputs.position.z = log2(max(0.000001, vertexOutputs.vFragmentDepth)) * uniforms.logarithmicDepthConstant;',
        '    // Barycentric lookup table: corner vi%3 → (1,0,0), (0,1,0), (0,0,1).',
        '    let baryLut = array<vec3<f32>, 3>(vec3<f32>(1.0,0.0,0.0), vec3<f32>(0.0,1.0,0.0), vec3<f32>(0.0,0.0,1.0));',
        '    vertexOutputs.vBary    = baryLut[vi % 3u];',
        '    vertexOutputs.vSlotIdx = f32(slot);',
        '    return vertexOutputs;',
        '}'
    ].join('\n');
}

function fragmentSource(opts: TerrainRenderOptions): string {
    return [
        slotStateWgslPreamble(),
        bakedHeader(opts),
        'var<storage, read> terrainPerm      : array<u32>;',
        'var<storage, read> terrainSlotState : array<u32>;',
        // Tile-cache atlas textures (sampled in the fast path). Declared with explicit samplers
        // so BabylonJS WebGPU auto-binds the sampler state from the texture's filter settings.
        'var uNormalAtlas        : texture_2d<f32>;',
        'var uNormalAtlasSampler : sampler;',
        'var uAlbedoAtlas        : texture_2d<f32>;',
        'var uAlbedoAtlasSampler : sampler;',
        // Coarse-mip atlases (8×8 per tile = ×8 downsample). Blended with mip0 by screen
        // footprint so the cache stays grain-free at distance (replaces the old minif gate).
        'var uCoarseNormal        : texture_2d<f32>;',
        'var uCoarseNormalSampler : sampler;',
        'var uCoarseAlbedo        : texture_2d<f32>;',
        'var uCoarseAlbedoSampler : sampler;',
        terrainNoiseWgsl,
        // df64 domain noise (cm-precise ground detail). Order matters: terrain_noise.wgsl (terrainCorner/
        // terrainPermAt/TERRAIN_MAX_*) and the baked TERRAIN_* constants must precede these, then df64 prims,
        // then the df64 noise. Same compose order as the metric eval kernel (proven to compile).
        terrainF64Wgsl,
        terrainNoiseDf64Wgsl,
        'uniform world : mat4x4<f32>;',
        'uniform uLightDirection : vec3<f32>;',
        'uniform logarithmicDepthConstant : f32;',
        'uniform uDebugLod : i32;',
        // Fragment perf-profiling mask (debug): skip heavy blocks to measure each one s GPU cost
        // via the P-HUD gpuMs. bit0 = skip the slope normal; bit1 = skip the df64 near-ground
        // detail block; bit2 = skip the crater rays; bit3 = skip AO; bit4 = skip GGX specular;
        // bit6 (64) = zero the per-vertex crater gradient in the normals (visual A/B; the crater
        // compute now lives in the vertex shader, so this no longer changes fragment cost).
        'uniform uPerfMask : i32;',
        // Camera position in planet-local sim units (= the SAME f32 value the df64 eval
        // subtracted to make `rel`). world = uCamAnchor + rel reconstructs the surface point
        // exactly (the camera's f32 rounding cancels), giving a frame-invariant, cm-precise
        // direction for the ground detail noise (no swim, no banding).
        'uniform uCamAnchor : vec3<f32>;',
        // Residual camera drift since the anchor (planet-local): anchorCamLocal - liveCamLocal.
        // `rel` is anchor-relative; `rel + uCamDelta` is the LIVE camera-relative position, so
        // camDistKm (detail-octave fade + aerial fog) tracks the live camera between re-bakes
        // instead of breathing/popping. worldHi = uCamAnchor + rel stays anchor-based (exact).
        'uniform uCamDelta : vec3<f32>;',
        // Runtime ambient (replaces the former TERRAIN_AMBIENT baked constant) and star intensity
        // multiplier for the diffuse+specular term. Both can be changed per-frame without a
        // material rebuild.
        'uniform uAmbient : vec3<f32>;',
        'uniform uLightIntensity : f32;',
        // Aerial perspective (optional). uAtmoDensity = 0 disables the fog completely.
        // Used for airless bodies with thin dust/gas hazes (NOT for full-atmosphere planets
        // that already have the atmospheric scattering post-process applied).
        'uniform uAtmoDensity : f32;',
        'uniform uAtmoColor   : vec3<f32>;',
        'varying vDir : vec3<f32>;',
        'varying vRel : vec3<f32>;',
        'varying vFragmentDepth : f32;',
        'varying vLevel : f32;',
        // Per-vertex crater gradient (see vertex shader): the dominant low-frequency relief, interpolated
        // instead of re-scanned per pixel. vCraterGrad = main/df64 normals; vCraterGradSlope = splat/AO.
        'varying vCraterGrad : vec3<f32>;',
        'varying vCraterGradSlope : vec3<f32>;',
        'varying vSlopeFbmGrad : vec3<f32>;',
        // Tile-cache fast path: per-corner barycentric coord for atlas UV; per-fragment slot index.
        'varying vBary    : vec3<f32>;',
        'varying vSlotIdx : f32;',
        // Procedural world-anchored albedo (no texture samplers). Driven by slope + altitude:
        // regolith on flats, rock on slopes, highland tint up high. `slope01` = 1 - dot(landform
        // normal, up) (0 flat) from the SMOOTH normal so rock follows landforms, not micro-bumps.
        'fn terrainGroundAlbedo(slope01 : f32, altKm : f32) -> vec3<f32> {',
        '    let rockW = smoothstep(TERRAIN_SLOPE_LO, TERRAIN_SLOPE_HI, slope01);',
        '    var base = mix(TERRAIN_REGOLITH, TERRAIN_ROCK, rockW);',
        '    let highW = smoothstep(TERRAIN_ALT_LO, TERRAIN_ALT_HI, altKm);',
        '    base = mix(base, base * TERRAIN_HIGHLAND_TINT, highW);',
        '    return base;',
        '}',
        // Per-LOD-level palette — mirrors LEVEL_COLORS / the implicit material's
        // terrainLodColor so the X-key debug view matches the rest of the terrain.
        'fn terrainLodColor(level : u32) -> vec3<f32> {',
        '    switch (level % 16u) {',
        '        case 0u: { return vec3<f32>(0.15, 0.15, 0.80); }',
        '        case 1u: { return vec3<f32>(0.10, 0.50, 0.90); }',
        '        case 2u: { return vec3<f32>(0.10, 0.75, 0.75); }',
        '        case 3u: { return vec3<f32>(0.10, 0.80, 0.30); }',
        '        case 4u: { return vec3<f32>(0.50, 0.85, 0.10); }',
        '        case 5u: { return vec3<f32>(0.90, 0.90, 0.10); }',
        '        case 6u: { return vec3<f32>(1.00, 0.65, 0.05); }',
        '        case 7u: { return vec3<f32>(1.00, 0.35, 0.05); }',
        '        case 8u: { return vec3<f32>(0.90, 0.10, 0.10); }',
        '        case 9u: { return vec3<f32>(0.80, 0.10, 0.50); }',
        '        case 10u: { return vec3<f32>(0.60, 0.10, 0.70); }',
        '        case 11u: { return vec3<f32>(0.40, 0.10, 0.80); }',
        '        case 12u: { return vec3<f32>(1.00, 1.00, 1.00); }',
        '        case 13u: { return vec3<f32>(0.70, 0.70, 0.70); }',
        '        case 14u: { return vec3<f32>(0.40, 0.40, 0.40); }',
        '        default: { return vec3<f32>(1.00, 0.00, 1.00); }',
        '    }',
        '}',
        // perfMask bit 7 (128): skip the 12 detail octaves → isolates macro vs detail cost.
        // Bit-identical to terrainNoiseNormalAtShared when bit 7 is clear.
        'fn terrainFbmGradWithMask(p: vec3<f32>, camDistKm: f32, radius: f32, fp: f32, macroOnly: bool) -> vec3<f32> {',
        '    return terrainFbmGradAt_core(p, camDistKm, radius, fp, macroOnly || (uniforms.uPerfMask & 128) != 0);',
        '}',
        '@fragment',
        'fn main(input : FragmentInputs) -> FragmentOutputs {',
        '    if (uniforms.uDebugLod != 0) {',
        '        let lc = terrainLodColor(u32(max(fragmentInputs.vLevel, 0.0)));',
        '        fragmentOutputs.color = vec4<f32>(lc, 1.0);',
        '        fragmentOutputs.fragDepth = log2(fragmentInputs.vFragmentDepth) * uniforms.logarithmicDepthConstant * 0.5;',
        '        return fragmentOutputs;',
        '    }',
        '    let dir = normalize(fragmentInputs.vDir);',
        '    let rel = fragmentInputs.vRel;',
        '    // Same per-vertex camera distance (km) the height decode used -> the detail',
        '    // octaves in the normal match the displaced geometry (no shading mismatch).',
        '    let camDistKm = length(rel + uniforms.uCamDelta);',
        '    // Pixel world footprint (km): how much surface one pixel covers. Huge at grazing -> used',
        '    // to Nyquist-fade sub-footprint fbm octaves out of the SHADING normal (kills grazing-sun',
        '    // normal grain at the source; height/collision are untouched). dpdx/dpdy of the local',
        '    // surface pos; rotation-invariant length = world km step.',
        '    let fpKm = max(length(dpdx(rel)), length(dpdy(rel)));',
        '    // World-anchored cartesian (planet-local km) for the triplanar albedo + altitude.',
        '    // = uCamAnchor + rel (f32 is fine here: textures tile and the scales stay coarse).',
        '    let worldHi = uniforms.uCamAnchor + rel;',
        '    let altKm = length(worldHi) - TERRAIN_RADIUS;',
        '    // Crater field is the dominant relief and LOW-FREQUENCY (cells >= 2 km), so it is evaluated',
        '    // PER VERTEX (see vertex shader) and read here as an interpolated varying instead of a per-',
        '    // pixel 6x27 scan inside each of the up-to-3 normals. bit6 zeroes it (visual A/B; the crater',
        '    // compute now lives in the vertex, so this isolates the FBM-only normal cost in the fragment).',
        '    let craterOff = (uniforms.uPerfMask & 64) != 0;',
        '    let craterGrad = select(fragmentInputs.vCraterGrad, vec3<f32>(0.0), craterOff);',
        '    let craterGradSlope = select(fragmentInputs.vCraterGradSlope, vec3<f32>(0.0), craterOff);',
        '    // Landform slope/AO normal — per-vertex macro fbm, always needed for specular roughness + AO.',
        '    var nSlope = dir;',
        '    if ((uniforms.uPerfMask & 1) == 0) { nSlope = terrainNormalFromGrad(dir, TERRAIN_RADIUS, fragmentInputs.vSlopeFbmGrad + craterGradSlope); }',
        '    let slope01 = clamp(1.0 - dot(nSlope, dir), 0.0, 1.0);',
        '    // Tile-cache fast path: if this slot has a baked atlas tile, sample normal+albedo (2 fetches)',
        '    // instead of 24+ simplex evaluations per pixel. perfMask bit 8 (256) forces the full noise',
        '    // path for visual A/B comparison (mask=0 → atlas, mask=256 → full noise).',
        '    let tsc_slotIdx = u32(fragmentInputs.vSlotIdx);',
        '    let tsc_sw      = terrainSlotState[tsc_slotIdx];',
        '    let tsc_hasTile = (tsc_sw & SLOT_HAS_TILE_BIT) != 0u;',
        '    let tsc_tileIdx = (tsc_sw >> SLOT_TILE_SHIFT) & SLOT_TILE_MASK;',
        '    var nLocal : vec3<f32>;',
        '    var albedo : vec3<f32>;',
        '    var rays   : f32 = 0.0;',
        '    // df64 ground-detail weight (cm-scale relief that fades in below GROUND_OFF_KM).',
        '    // Baked tiles are evaluated in f32 dir space and CANNOT carry df64 detail, so the',
        '    // fast path is only faithful where dFade == 0. Below that we fall through to the',
        '    // live path; since dFade -> 0 at the threshold, the handoff is seamless (and it is',
        '    // the SAME criterion live neighbours use, so no baked/live patchwork forms).',
        '    let tsc_dFade = 1.0 - smoothstep(TERRAIN_GROUND_ON_KM, TERRAIN_GROUND_OFF_KM, camDistKm);',
        '    // Coarse-mip LOD blend (replaces the old minification gate). mip0 = the 64x64 tile;',
        '    // coarse = an 8x8 downsample (x8) baked by the reduce pass. vBary.yz spans the tile',
        '    // [0,1]; its screen derivative * 63 = atlas texels per pixel. As the tile minifies',
        '    // past 1 texel/px we blend toward the coarse level (footprint-matched), which kills',
        '    // the inter-tile aliasing a mip-less point sample produced at distance — so the cache',
        '    // now stays active (and grain-free) far away instead of falling back to the live path.',
        '    // Derivatives are read in uniform control flow (before the branch) so they are defined.',
        '    let tsc_texPerPx = max(length(dpdx(fragmentInputs.vBary.yz)), length(dpdy(fragmentInputs.vBary.yz))) * 63.0;',
        '    // Use the cache only where the tile resolves at least as fine as the screen pixel',
        '    // (texPerPx >= MAG_GATE). Below that the tile is magnified and under-resolves vs the',
        '    // live per-pixel noise -> flat facets, so fall through to live. dFade gates df64 <150m.',
        '    if (tsc_hasTile && (uniforms.uPerfMask & 256) == 0 && tsc_dFade <= 0.0 && tsc_texPerPx >= TERRAIN_TILE_MAG_GATE) {',
        '        let tileRow = tsc_tileIdx / ATLAS_TILES_PER_ROW;',
        '        let tileCol = tsc_tileIdx % ATLAS_TILES_PER_ROW;',
        '        // mip0 UV: 64x64 tiles packed in the 8192 atlas.',
        '        let atlasUv = vec2<f32>(',
        '            (f32(tileCol * ATLAS_TILE_SIZE) + fragmentInputs.vBary.y * 63.0 + 0.5) / 8192.0,',
        '            (f32(tileRow * ATLAS_TILE_SIZE) + fragmentInputs.vBary.z * 63.0 + 0.5) / 8192.0',
        '        );',
        '        // coarse UV: 8x8 tiles packed in the 1024 atlas (same tile layout).',
        '        let coarseDim = f32(COARSE_TILES_PER_ROW * COARSE_TILE_SIZE);',
        '        let coarseUv = vec2<f32>(',
        '            (f32(tileCol * COARSE_TILE_SIZE) + fragmentInputs.vBary.y * 7.0 + 0.5) / coarseDim,',
        '            (f32(tileRow * COARSE_TILE_SIZE) + fragmentInputs.vBary.z * 7.0 + 0.5) / coarseDim',
        '        );',
        '        // Blend weight: 0 at <=1 texel/px (pure mip0), 1 at >=8 texel/px (pure coarse). log2(8)=3.',
        '        let lodT = clamp(log2(max(tsc_texPerPx, 1.0)) / 3.0, 0.0, 1.0);',
        '        let nMip0   = textureSampleLevel(uNormalAtlas,  uNormalAtlasSampler,  atlasUv,  0.0).xyz;',
        '        let nCoarse = textureSampleLevel(uCoarseNormal, uCoarseNormalSampler, coarseUv, 0.0).xyz;',
        '        nLocal       = normalize(mix(nMip0, nCoarse, lodT));',
        '        let aMip0    = textureSampleLevel(uAlbedoAtlas,  uAlbedoAtlasSampler,  atlasUv,  0.0);',
        '        let aCoarse  = textureSampleLevel(uCoarseAlbedo, uCoarseAlbedoSampler, coarseUv, 0.0);',
        '        let abPacked = mix(aMip0, aCoarse, lodT);',
        '        albedo       = abPacked.rgb;',
        '        rays         = abPacked.a;',
        '    } else {',
        '        // Full noise path: 24+ simplex evaluations + optional df64 near-ground detail.',
        '        let fbmGradMain = terrainFbmGradWithMask(dir, camDistKm, TERRAIN_RADIUS, fpKm, false);',
        '        nLocal = terrainNormalFromGrad(dir, TERRAIN_RADIUS, fbmGradMain + craterGrad);',
        '        let dFade = tsc_dFade;',
        '        if (dFade > 0.0 && (uniforms.uPerfMask & 2) == 0) {',
        '            let wx = df64_add(df64_from_f32(uniforms.uCamAnchor.x), df64_from_f32(rel.x));',
        '            let wy = df64_add(df64_from_f32(uniforms.uCamAnchor.y), df64_from_f32(rel.y));',
        '            let wz = df64_add(df64_from_f32(uniforms.uCamAnchor.z), df64_from_f32(rel.z));',
        '            let len2 = df64_add(df64_add(df64_mul(wx, wx), df64_mul(wy, wy)), df64_mul(wz, wz));',
        '            let inv = df64_invsqrt(len2);',
        '            let dxD = df64_mul(wx, inv);',
        '            let dyD = df64_mul(wy, inv);',
        '            let dzD = df64_mul(wz, inv);',
        '            let nDf = terrainNoiseNormalAtShared_df64(dxD, dyD, dzD, TERRAIN_RADIUS, camDistKm, craterGrad);',
        '            nLocal = normalize(mix(nLocal, nDf, dFade));',
        '            let dgrad = terrainGroundDetailGrad_df64(dxD, dyD, dzD, TERRAIN_GROUND_BASE_FREQ, TERRAIN_GROUND_DETAIL_OCTAVES);',
        '            let tg = dgrad - dot(dgrad, nLocal) * nLocal;',
        '            nLocal = normalize(nLocal - (TERRAIN_GROUND_STRENGTH * dFade) * tg);',
        '        }',
        '        albedo = terrainGroundAlbedo(slope01, altKm);',
        '        albedo = albedo * (1.0 + TERRAIN_PLAINS_AMP * terrainSimplex3_d(dir * TERRAIN_PLAINS_FREQ).x);',
        '        if ((uniforms.uPerfMask & 4) == 0) { rays = craterRays(dir, TERRAIN_RADIUS, camDistKm); }',
        '    }',
        '    // Diffuse normal AA: where nLocal varies fast across a pixel (sub-pixel foreground',
        '    // micro-relief), blend it toward the smooth landform normal (nSlope) so the diffuse ndl',
        '    // stops aliasing into grain. Variance-based so macro relief (slow per-pixel change) is',
        '    // preserved and the far field is not over-flattened (which exposes geometric sparkle).',
        '    let nVar = dot(dpdx(nLocal), dpdx(nLocal)) + dot(dpdy(nLocal), dpdy(nLocal));',
        '    nLocal = normalize(mix(nSlope, nLocal, 1.0 / (1.0 + TERRAIN_NORMAL_AA * nVar)));',
        '    let nWorld = normalize((uniforms.world * vec4<f32>(nLocal, 0.0)).xyz);',
        '    // Curvature-based ambient occlusion: deviation of the SMOOTH landform normal from',
        '    // the radial direction. nSlope is at TERRAIN_SLOPE_DIST km so micro-bumps are faded out,',
        '    // giving macro-scale AO (craters + valleys) without per-pixel noise speckling.',
        '    var ao = 1.0;',
        '    if ((uniforms.uPerfMask & 8) == 0) {',
        '        let curvature = clamp(1.0 - dot(nSlope, dir), 0.0, 1.0);',
        '        ao = 1.0 - TERRAIN_AO_STRENGTH * curvature;',
        '    }',
        '    let L = normalize(-uniforms.uLightDirection);',
        '    // View direction (surface -> camera) in the same world-aligned space as nWorld and L:',
        '    // rel is the camera-relative surface position, so world * rel points camera -> surface.',
        '    let V = normalize(-(uniforms.world * vec4<f32>(rel, 0.0)).xyz);',
        '    let NdL = max(dot(nWorld, L), 0.0);',
        '    let NdV = max(dot(nWorld, V), 1e-3);',
        '    // Lommel-Seeliger single-scattering term NdL/(NdL+NdV): the airless-regolith look. It',
        '    // does NOT fall off toward the limb like Lambert and brightens at grazing emission, so',
        '    // the planet reads flat/uniformly lit (real Moon) instead of a smooth-shaded ball.',
        '    let ls = NdL / (NdL + NdV);',
        '    var refl = mix(NdL, 2.0 * ls, TERRAIN_LUNAR_LS);',
        '    // Opposition surge: a gentle hotspot when the Sun is near the camera back (low phase).',
        '    let cosPhase = clamp(dot(V, L), -1.0, 1.0);',
        '    refl = refl * (1.0 + TERRAIN_OPP_AMP * smoothstep(TERRAIN_OPP_COS, 1.0, cosPhase));',
        '    // Mean-preserving normal-AA (uPerfMask bit5): the variance-smoothed normal over-brightens',
        '    // the diffuse at grazing because the BRDF is concave there (Jensen). Darken by the sub-pixel',
        '    // normal variance (nVar) scaled by grazing concavity (1/(NdL+NdV)) so E[shading] is restored',
        '    // without re-introducing grain (the normal stays smoothed). Tune K via TERRAIN_MEAN_AA_K.',
        '    if ((uniforms.uPerfMask & 32) != 0) {',
        '        let conc = nVar / (NdL + NdV + 0.05);',
        '        refl = refl * (1.0 - clamp(TERRAIN_MEAN_AA_K * conc, 0.0, 0.85));',
        '    }',
        '    // Cook-Torrance specular (D·F·G). H = half-vector. Slope-driven roughness: flat terrain',
        '    // is smoother (lower roughness) than steep slopes. NdL gate zeroes spec in shadow.',
        '    var spec = 0.0;',
        '    if ((uniforms.uPerfMask & 16) == 0) {',
        '        let H       = normalize(L + V);',
        '        let NdH     = max(dot(nWorld, H), 0.0);',
        '        let VdH     = max(dot(V, H), 0.0);',
        '        let roughness = mix(TERRAIN_ROUGH_LO, TERRAIN_ROUGH_HI, slope01);',
        '        let alpha   = roughness * roughness;',
        '        // Geometric specular AA (Kaplanyan): where the shading normal varies fast across a',
        '        // pixel (per-pixel micro-relief, worst at grazing toward the light) widen the GGX',
        '        // lobe by the screen-space normal variance so its sharp peak cannot alias into',
        '        // sparkle/fireflies. On smooth flats the variance ~0 so the highlight is preserved.',
        '        let dNx = dpdx(nWorld);',
        '        let dNy = dpdy(nWorld);',
        '        let varBump = TERRAIN_SPEC_AA * (dot(dNx, dNx) + dot(dNy, dNy));',
        '        let alpha2  = clamp(alpha * alpha + varBump, 0.0, 1.0);',
        '        // GGX NDF',
        '        let denom = NdH * NdH * (alpha2 - 1.0) + 1.0;',
        '        let D = alpha2 / (3.14159 * denom * denom);',
        '        // Schlick Fresnel',
        '        let F = TERRAIN_F0 + (1.0 - TERRAIN_F0) * pow(1.0 - VdH, 5.0);',
        '        // Smith-GGX geometry (k = alpha/2, IBL approx) on the BASE roughness.',
        '        let k   = alpha * 0.5;',
        '        let g1L = NdL / (NdL * (1.0 - k) + k);',
        '        let g1V = NdV / (NdV * (1.0 - k) + k);',
        '        let G   = g1L * g1V;',
        '        // Firefly clamp caps any residual grazing blow-up of the (1/(4·NdL·NdV)) term.',
        '        spec = min((D * F * G) / (4.0 * NdL * NdV + 1e-4) * NdL, TERRAIN_SPEC_MAX);',
        '    }',
        '    let lighting = uniforms.uAmbient * ao + TERRAIN_LIGHTCOLOR * (uniforms.uLightIntensity * refl);',
        '    // Ejecta ray brightness (baked into atlas.a for the fast path; computed inline in fallback).',
        '    albedo = albedo + vec3<f32>(rays);',
        '    var finalColor = albedo * lighting + TERRAIN_LIGHTCOLOR * (uniforms.uLightIntensity * spec);',
        '    if (uniforms.uAtmoDensity > 0.0) {',
        '        // Altitude-weighted exponential fog: dense near surface, zero above ~1% of radius.',
        '        let altFactor = clamp(1.0 - altKm / (TERRAIN_RADIUS * 0.01), 0.0, 1.0);',
        '        let fogFactor = exp(-uniforms.uAtmoDensity * camDistKm * altFactor);',
        '        finalColor = mix(uniforms.uAtmoColor, finalColor, fogFactor);',
        '    }',
        '    fragmentOutputs.color = vec4<f32>(finalColor, 1.0);',
        '    fragmentOutputs.fragDepth = log2(fragmentInputs.vFragmentDepth) * uniforms.logarithmicDepthConstant * 0.5;',
        '    return fragmentOutputs;',
        '}'
    ].join('\n');
}

export type TerrainRenderMaterial = {
    material: ShaderMaterial;
    permBuffer: StorageBufferType;
    setLightDirection(dir: Vector3): void;
    setDebugLod(on: boolean): void;
    setPerfMask(mask: number): void;
    setCamAnchor(camLocal: Vector3): void;
    setCamDelta(delta: Vector3): void;
    setAmbient(ambient: Vector3): void;
    setLightIntensity(intensity: number): void;
    setAtmoDensity(density: number): void;
    setAtmoColor(color: Vector3): void;
    dispose(): void;
};

/** Build the WGSL render material and bind the heap + positions + permutation buffers. */
export function buildTerrainRenderMaterial(
    scene: Scene,
    key: string,
    opts: TerrainRenderOptions,
    heapBuffer: StorageBufferType,
    positionsBuffer: StorageBufferType,
    indicesBuffer: StorageBufferType,
    /** Optional tile-cache bindings for the fast-path atlas sampling. */
    slotStateBuffer?: StorageBufferType,
    normalAtlas?: BaseTexture | null,
    albedoAtlas?: BaseTexture | null,
    coarseNormalAtlas?: BaseTexture | null,
    coarseAlbedoAtlas?: BaseTexture | null
): TerrainRenderMaterial {
    const engine = scene.getEngine() as WebGPUEngine;

    const material = new ShaderMaterial(
        `terrain_${key}`,
        scene,
        { vertexSource: vertexSource(opts), fragmentSource: fragmentSource(opts) },
        {
            shaderLanguage: ShaderLanguage.WGSL,
            attributes: ['position'],
            uniforms: ['viewProjection', 'world', 'uLightDirection', 'logarithmicDepthConstant', 'uDebugLod', 'uPerfMask', 'uCamAnchor', 'uCamDelta', 'uAmbient', 'uLightIntensity', 'uAtmoDensity', 'uAtmoColor'],
            storageBuffers: ['terrainHeap', 'terrainPos', 'terrainIndices', 'terrainPerm', 'terrainSlotState'],
            samplers: ['uNormalAtlas', 'uAlbedoAtlas', 'uCoarseNormal', 'uCoarseAlbedo']
        }
    );
    // Back-face culling: the octahedron is consistently wound so only the camera-facing
    // surface should draw. With it OFF, the planet's far-side / underside leaves (coarsened
    // by the backside cull, but still live and drawn) bleed THROUGH the near surface and
    // paint coarse facets over the fine foreground near the horizon. The template winding
    // (createTerrainTemplateMesh: indices [0,2,1]) makes the OUTER surface front-facing so
    // this culls the inner/far side, not the visible near surface.
    material.backFaceCulling = true;

    // logarithmicDepthConstant is not auto-bound for a ShaderMaterial; refresh it each
    // bind from the active camera's far plane (mirrors the implicit material).
    material.onBindObservable.add(() => {
        const cam = scene.activeCamera;
        const maxZ = cam && cam.maxZ > 0 ? cam.maxZ : 1e9;
        material.setFloat('logarithmicDepthConstant', 2.0 / Math.log2(maxZ + 1.0));
    });

    // Seeded permutation table (256 u32) — must match the CPU/noise field.
    const perm = buildPerm(opts.noise.seed);
    const permU32 = new Uint32Array(256);
    for (let i = 0; i < 256; i++) permU32[i] = perm[i];
    const permBuffer = new StorageBuffer(
        engine,
        256 * 4,
        Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_WRITE,
        `terrain_perm_${key}`
    );
    permBuffer.update(permU32);

    material.setStorageBuffer('terrainHeap', heapBuffer);
    material.setStorageBuffer('terrainPos', positionsBuffer);
    material.setStorageBuffer('terrainIndices', indicesBuffer);
    material.setStorageBuffer('terrainPerm', permBuffer);
    if (slotStateBuffer) material.setStorageBuffer('terrainSlotState', slotStateBuffer);
    if (normalAtlas) material.setTexture('uNormalAtlas', normalAtlas);
    if (albedoAtlas) material.setTexture('uAlbedoAtlas', albedoAtlas);
    if (coarseNormalAtlas) material.setTexture('uCoarseNormal', coarseNormalAtlas);
    if (coarseAlbedoAtlas) material.setTexture('uCoarseAlbedo', coarseAlbedoAtlas);
    material.setVector3('uLightDirection', new Vector3(0, -1, 0));
    material.setInt('uDebugLod', 0);
    material.setInt('uPerfMask', 0);
    material.setVector3('uCamAnchor', new Vector3(0, 0, 0));
    material.setVector3('uCamDelta', new Vector3(0, 0, 0));
    material.setVector3('uAmbient', opts.ambient ?? new Vector3(0.008, 0.008, 0.008));
    material.setFloat('uLightIntensity', opts.lightIntensity ?? 1.0);
    material.setFloat('uAtmoDensity', opts.atmoDensity ?? 0);
    material.setVector3('uAtmoColor', opts.atmoColor ?? new Vector3(0, 0, 0));

    return {
        material,
        permBuffer,
        setLightDirection(dir: Vector3): void {
            material.setVector3('uLightDirection', dir);
        },
        setDebugLod(on: boolean): void {
            material.setInt('uDebugLod', on ? 1 : 0);
        },
        setPerfMask(mask: number): void {
            material.setInt('uPerfMask', mask | 0);
        },
        setCamAnchor(camLocal: Vector3): void {
            material.setVector3('uCamAnchor', camLocal);
        },
        setCamDelta(delta: Vector3): void {
            material.setVector3('uCamDelta', delta);
        },
        setAmbient(ambient: Vector3): void {
            material.setVector3('uAmbient', ambient);
        },
        setLightIntensity(intensity: number): void {
            material.setFloat('uLightIntensity', intensity);
        },
        setAtmoDensity(density: number): void {
            material.setFloat('uAtmoDensity', density);
        },
        setAtmoColor(color: Vector3): void {
            material.setVector3('uAtmoColor', color);
        },
        dispose(): void {
            material.dispose();
            permBuffer.dispose();
        }
    };
}

/** A 3-vertex template mesh; the implicit shader draws `forcedInstanceCount` of it. */
export function createTerrainTemplateMesh(scene: Scene, key: string): Mesh {
    const mesh = new Mesh(`terrain_mesh_${key}`, scene);
    const vd = new VertexData();
    vd.positions = [0, 0, 0, 0, 0, 0, 0, 0, 0]; // ignored — VS uses vertexIndex
    // Winding [0,2,1] (not [0,1,2]): the EvaluateLEB corner order (v0=right, v1=apex,
    // v2=left) plus the clip-space Y-flip leaves the OUTER surface back-facing; reversing
    // the assembly order makes the outer surface front-facing so backFaceCulling can keep
    // it and cull the inner/far side. Verified with a front_facing diagnostic (outer=green).
    vd.indices = [0, 2, 1];
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true; // procedural bounds — never frustum-cull
    return mesh;
}
