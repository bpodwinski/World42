/**
 * OCBT render material (WebGPU, WGSL) — the pool-CBT twin of
 * gpu_cbt_render_material.ts. The mesh is implicit: a 3-vertex template drawn once
 * per pool slot (`forcedInstanceCount = capacity`). The vertex shader reads the
 * per-slot heap id (to skip dead slots) and the EvaluateLEB positions buffer (3
 * unit-dir corners per slot, decoded on the GPU in ocbt_topo_eval_leb.compute.wgsl),
 * picks corner `vertexIndex`, displaces it radially by the fbm height, and projects.
 * The fragment shader recomputes the per-pixel normal from the analytic noise
 * gradient — identical to the implicit-CBT material, so shading matches the rest of
 * the terrain. No CPU geometry, no per-frame upload.
 *
 * Decode convention: the positions buffer is produced by ocbt_eval_leb.wgsl (the
 * REFERENCE leb convention over the consistently-wound octahedron), so this material
 * never touches the legacy cbt_leb decode.
 */
import {
    Mesh,
    ShaderLanguage,
    ShaderMaterial,
    StorageBuffer,
    VertexData,
    Vector3,
    Constants,
    type Scene,
    type StorageBuffer as StorageBufferType,
    type WebGPUEngine
} from '@babylonjs/core';
import { buildPerm, type NoiseParams } from '../cbt_noise';
import { DEFAULT_LIGHTING, type ResolvedLighting } from '../../../../game_world/stellar_system/planet_lighting';
import cbtNoiseWgsl from '../../../../assets/shaders/cbt/gpu/cbt_noise.wgsl';
import ocbtF64Wgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_f64.wgsl';
import cbtNoiseDf64Wgsl from '../../../../assets/shaders/cbt/ocbt/cbt_noise_df64.wgsl';

/** WGSL f32 literal (always has a decimal point). */
function f(x: number): string {
    return Number.isInteger(x) ? `${x}.0` : `${x}`;
}

export type OcbtRenderOptions = {
    radius: number;
    noise: NoiseParams;
    albedo?: Vector3;
    ambient?: Vector3;
    lightColor?: Vector3;
    lightIntensity?: number;
    atmoDensity?: number;
    atmoColor?: Vector3;
    /** Per-planet resolved lighting params. When absent, bakedHeader uses DEFAULT_LIGHTING. */
    lighting?: ResolvedLighting;
};

function bakedHeader(opts: OcbtRenderOptions): string {
    const n = opts.noise;
    const L = opts.lighting ?? DEFAULT_LIGHTING;
    const g = L.ground;
    const t = L.terrain;
    const b = L.brdf;
    const albedo = opts.albedo ?? new Vector3(L.albedo[0], L.albedo[1], L.albedo[2]);
    const lightColor = opts.lightColor ?? new Vector3(1, 1, 1);
    return [
        `const CBT_RADIUS : f32 = ${f(opts.radius)};`,
        `const CBT_OCTAVES : i32 = ${Math.max(0, Math.floor(n.octaves))};`,
        `const CBT_BASE_FREQ : f32 = ${f(n.baseFrequency)};`,
        `const CBT_BASE_AMP : f32 = ${f(n.baseAmplitude)};`,
        `const CBT_LACUNARITY : f32 = ${f(n.lacunarity)};`,
        `const CBT_PERSISTENCE : f32 = ${f(n.persistence)};`,
        `const CBT_GLOBAL_AMP : f32 = ${f(n.globalAmplitude)};`,
        `const CBT_DETAIL_OCTAVES : i32 = ${Math.max(0, Math.floor(n.detailOctaves ?? 0))};`,
        `const CBT_DETAIL_RANGE : f32 = ${f(n.detailRange ?? 60)};`,
        `const CBT_ALBEDO : vec3<f32> = vec3<f32>(${f(albedo.x)}, ${f(albedo.y)}, ${f(albedo.z)});`,
        `const CBT_LIGHTCOLOR : vec3<f32> = vec3<f32>(${f(lightColor.x)}, ${f(lightColor.y)}, ${f(lightColor.z)});`,
        // Near-ground detail band (world-anchored df64 micro-relief). ON/OFF in km = the
        // camera-distance fade; STRENGTH = normal-tilt amount; BASE_FREQ = first ground
        // octave's frequency on the UNIT dir (= radius / wavelength; 1 m base wavelength).
        `const CBT_GROUND_ON_KM : f32 = ${f(g.onKm)};`,
        `const CBT_GROUND_OFF_KM : f32 = ${f(g.offKm)};`,
        `const CBT_GROUND_STRENGTH : f32 = ${f(g.strength)};`,
        `const CBT_GROUND_DETAIL_OCTAVES : i32 = ${Math.max(0, Math.floor(g.octaves))};`,
        `const CBT_GROUND_BASE_FREQ : f32 = ${f(opts.radius * 1000)};`,
        // Procedural albedo splatting driven by SLOPE + ALTITUDE (physically meaningful, not
        // random color blotches): REGOLITH on flats, darker greyer ROCK on slopes, HIGHLAND
        // tint by altitude. Slope is read from the SMOOTH landform normal (CBT_SLOPE_DIST
        // fades the cm micro-relief out so rock follows 30m+ hills/crater walls, not per-pixel
        // bumps). SLOPE_* are in slope units = 1 - dot(landformNormal, up); 0 = flat.
        ...(() => {
            const gv = (albedo.x + albedo.y + albedo.z) / 3;
            const rk = (c: number) => 0.45 * (0.5 * c + 0.5 * gv); // darker + desaturated
            return [
                `const CBT_REGOLITH : vec3<f32> = vec3<f32>(${f(albedo.x)}, ${f(albedo.y)}, ${f(albedo.z)});`,
                `const CBT_ROCK : vec3<f32> = vec3<f32>(${f(rk(albedo.x))}, ${f(rk(albedo.y))}, ${f(rk(albedo.z))});`
            ];
        })(),
        `const CBT_HIGHLAND_TINT : vec3<f32> = vec3<f32>(${f(t.highlandTint[0])}, ${f(t.highlandTint[1])}, ${f(t.highlandTint[2])});`,
        `const CBT_SLOPE_LO : f32 = ${f(t.slopeLo)};`,
        `const CBT_SLOPE_HI : f32 = ${f(t.slopeHi)};`,
        `const CBT_SLOPE_DIST : f32 = ${f(t.slopeDist)};`,
        `const CBT_ALT_LO : f32 = ${f(opts.noise.globalAmplitude * 0.25)};`,
        `const CBT_ALT_HI : f32 = ${f(opts.noise.globalAmplitude * 0.65)};`,
        // Smooth plains vs cratered highlands: a BROAD (continental ~400 km), SUBTLE brightness
        // variation so the surface isn't uniform — NOT the fine blotches. dir-based (no swim).
        `const CBT_PLAINS_FREQ : f32 = ${f(opts.radius / 400)};`,
        `const CBT_PLAINS_AMP : f32 = ${f(t.plainsAmp)};`,
        // Lunar (airless-regolith) BRDF. CBT_LUNAR_LS blends Lambert (0) <-> Lommel-Seeliger (1):
        // the regolith reflects flat, with NO limb darkening (a full Moon looks like a uniform
        // disc, not a shaded sphere) and slight limb BRIGHTENING. CBT_OPP_* is the opposition
        // surge (hotspot when the Sun is at the camera's back, low phase angle).
        `const CBT_LUNAR_LS : f32 = ${f(b.lunarLs)};`,
        `const CBT_OPP_AMP : f32 = ${f(b.oppAmp)};`,
        `const CBT_OPP_COS : f32 = ${f(b.oppCos)};`,
        // Curvature AO: ambient occlusion from deviation of terrain normal vs radial direction.
        // Applied to ambient only. Computed from nSlope (smooth normal) for macro-scale AO.
        `const CBT_AO_STRENGTH : f32 = ${f(b.aoStrength)};`,
        // Cook-Torrance specular. Slope-driven roughness (flat=smoother, steep=matte).
        // CBT_F0 is Fresnel at normal incidence (~0.04 for dielectric rock/regolith).
        // Regolith is MATTE (Moon/Mercury) — a high roughness floor gives a broad, dim sheen
        // instead of a sharp glossy lobe that blotches/sparkles on every micro-bump toward the Sun.
        `const CBT_ROUGH_LO : f32 = ${f(b.roughLo)};`,
        `const CBT_ROUGH_HI : f32 = ${f(b.roughHi)};`,
        `const CBT_F0 : f32 = ${f(b.f0)};`,
        // Geometric specular antialiasing: scales the screen-space normal variance added to
        // roughness^2. Higher = more de-sparkle (softer highlight under micro-relief / at grazing).
        `const CBT_SPEC_AA : f32 = ${f(b.specAa)};`,
        // Firefly clamp on the specular term (caps blown-out grazing pixels).
        `const CBT_SPEC_MAX : f32 = ${f(b.specMax)};`,
        // Diffuse normal antialiasing: where the per-pixel shading normal varies faster than the
        // pixel can resolve (fine foreground micro-relief), blend toward the smooth landform normal
        // so the diffuse ndl stops aliasing into grain. Variance-based (dpdx of the normal) so it
        // targets sub-pixel detail without over-flattening the far field. Higher = smoother sooner.
        `const CBT_NORMAL_AA : f32 = 12.0;`
    ].flat().join('\n');
}

function vertexSource(opts: OcbtRenderOptions): string {
    return [
        bakedHeader(opts),
        'var<storage, read> ocbtHeap : array<u32>;', // 2 u32/slot (u64 lo,hi)
        'var<storage, read> ocbtPos : array<f32>;', // 18 f32/slot: per corner [relative.xyz, dir.xyz]
        'var<storage, read> ocbtIndices : array<u32>;', // compacted live-slot list
        'var<storage, read> cbtPerm : array<u32>;',
        cbtNoiseWgsl,
        // Camera-relative path (Phase 3): the EvaluateLEB pass already produced each
        // corner CAMERA-RELATIVE in df64 then narrowed, so the per-vertex magnitude is
        // small and precise. renderPos = mat3(world) * relative (the planet-center->camera
        // translation cancels exactly: T_render = -R*camLocal, so R*localPos + T_render =
        // R*(localPos - camLocal) = R*relative). We therefore need viewProjection + the
        // world ROTATION/SCALE only, NOT worldViewProjection (which re-adds the big offset).
        'uniform viewProjection : mat4x4<f32>;',
        'uniform world : mat4x4<f32>;',
        'uniform logarithmicDepthConstant : f32;',
        'varying vDir : vec3<f32>;',
        'varying vRel : vec3<f32>;',
        'varying vFragmentDepth : f32;',
        'varying vLevel : f32;',
        'attribute position : vec3<f32>;',
        '@vertex',
        'fn main(input : VertexInputs) -> FragmentInputs {',
        '    // Compacted draw: instance i -> live slot. The over-estimated forcedInstanceCount',
        '    // may index a stale tail entry (now-dead slot) -> the heap-id-0 gate degenerates it.',
        '    let slot = ocbtIndices[vertexInputs.instanceIndex];',
        '    let lo = ocbtHeap[slot * 2u];',
        '    let hi = ocbtHeap[slot * 2u + 1u];',
        '    // Dead pool slot (heap id 0): collapse to a clipped degenerate triangle.',
        '    if (lo == 0u && hi == 0u) {',
        '        vertexOutputs.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);',
        '        vertexOutputs.vDir = vec3<f32>(0.0, 1.0, 0.0);',
        '        vertexOutputs.vRel = vec3<f32>(0.0, 0.0, 0.0);',
        '        vertexOutputs.vFragmentDepth = 1.0;',
        '        vertexOutputs.vLevel = 0.0;',
        '        return vertexOutputs;',
        '    }',
        '    let vi = vertexInputs.vertexIndex;',
        '    let base = slot * 18u + vi * 6u;',
        '    // rel is already the TERRAIN-displaced camera-relative position (the df64',
        '    // EvaluateLEB pass adds the fbm height now, so the topology metric/frustum stay',
        '    // terrain-aware). The VS just projects it; dir is kept for the fragment normal.',
        '    let localRel = vec3<f32>(ocbtPos[base], ocbtPos[base + 1u], ocbtPos[base + 2u]);',
        '    let dir = vec3<f32>(ocbtPos[base + 3u], ocbtPos[base + 4u], ocbtPos[base + 5u]);',
        '    let R = mat3x3<f32>(uniforms.world[0].xyz, uniforms.world[1].xyz, uniforms.world[2].xyz);',
        '    let renderPos = R * localRel;',
        '    vertexOutputs.position = uniforms.viewProjection * vec4<f32>(renderPos, 1.0);',
        '    // Hand-written WGSL ShaderMaterial: Babylon does NOT auto-inject the WebGPU',
        '    // NDC-Y flip (it does for transpiled GLSL), so flip clip-space Y to match',
        '    // the worker/GLSL terrain (otherwise the planet renders upside-down).',
        '    vertexOutputs.position.y = -vertexOutputs.position.y;',
        '    vertexOutputs.vDir = dir;',
        '    // Camera-relative position (sim units = km): its length is the per-vertex',
        '    // distance to camera that drives the detail-octave fade in the fragment normal.',
        '    vertexOutputs.vRel = localRel;',
        '    // Tree depth = firstLeadingBit(heap); faces are depth 3 => level = depth - 3.',
        '    var depth : u32;',
        '    if (hi != 0u) { depth = 32u + firstLeadingBit(hi); } else { depth = firstLeadingBit(lo); }',
        '    vertexOutputs.vLevel = f32(depth) - 3.0;',
        '    vertexOutputs.vFragmentDepth = 1.0 + vertexOutputs.position.w;',
        '    vertexOutputs.position.z = log2(max(0.000001, vertexOutputs.vFragmentDepth)) * uniforms.logarithmicDepthConstant;',
        '    return vertexOutputs;',
        '}'
    ].join('\n');
}

function fragmentSource(opts: OcbtRenderOptions): string {
    return [
        bakedHeader(opts),
        'var<storage, read> cbtPerm : array<u32>;',
        cbtNoiseWgsl,
        // df64 domain noise (cm-precise ground detail). Order matters: cbt_noise.wgsl (cbtCorner/
        // cbtPermAt/CBT_MAX_*) and the baked CBT_* constants must precede these, then df64 prims,
        // then the df64 noise. Same compose order as the metric eval kernel (proven to compile).
        ocbtF64Wgsl,
        cbtNoiseDf64Wgsl,
        'uniform world : mat4x4<f32>;',
        'uniform uLightDirection : vec3<f32>;',
        'uniform logarithmicDepthConstant : f32;',
        'uniform uDebugLod : i32;',
        // Fragment perf-profiling mask (debug): skip heavy blocks to measure each one s GPU cost
        // via the P-HUD gpuMs. bit0 = skip the slope normal; bit1 = skip the df64 near-ground
        // detail block; bit2 = skip the crater rays; bit3 = skip AO; bit4 = skip GGX specular.
        'uniform uPerfMask : i32;',
        // Camera position in planet-local sim units (= the SAME f32 value the df64 eval
        // subtracted to make `rel`). world = uCamAnchor + rel reconstructs the surface point
        // exactly (the camera's f32 rounding cancels), giving a frame-invariant, cm-precise
        // direction for the ground detail noise (no swim, no banding).
        'uniform uCamAnchor : vec3<f32>;',
        // Runtime ambient (replaces the former CBT_AMBIENT baked constant) and star intensity
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
        // Procedural world-anchored albedo (no texture samplers). Driven by slope + altitude:
        // regolith on flats, rock on slopes, highland tint up high. `slope01` = 1 - dot(landform
        // normal, up) (0 flat) from the SMOOTH normal so rock follows landforms, not micro-bumps.
        'fn cbtGroundAlbedo(slope01 : f32, altKm : f32) -> vec3<f32> {',
        '    let rockW = smoothstep(CBT_SLOPE_LO, CBT_SLOPE_HI, slope01);',
        '    var base = mix(CBT_REGOLITH, CBT_ROCK, rockW);',
        '    let highW = smoothstep(CBT_ALT_LO, CBT_ALT_HI, altKm);',
        '    base = mix(base, base * CBT_HIGHLAND_TINT, highW);',
        '    return base;',
        '}',
        // Per-LOD-level palette — mirrors LEVEL_COLORS / the implicit material's
        // cbtLodColor so the X-key debug view matches the rest of the terrain.
        'fn cbtLodColor(level : u32) -> vec3<f32> {',
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
        '@fragment',
        'fn main(input : FragmentInputs) -> FragmentOutputs {',
        '    if (uniforms.uDebugLod != 0) {',
        '        let lc = cbtLodColor(u32(max(fragmentInputs.vLevel, 0.0)));',
        '        fragmentOutputs.color = vec4<f32>(lc, 1.0);',
        '        fragmentOutputs.fragDepth = log2(fragmentInputs.vFragmentDepth) * uniforms.logarithmicDepthConstant * 0.5;',
        '        return fragmentOutputs;',
        '    }',
        '    let dir = normalize(fragmentInputs.vDir);',
        '    let rel = fragmentInputs.vRel;',
        '    // Same per-vertex camera distance (km) the height decode used -> the detail',
        '    // octaves in the normal match the displaced geometry (no shading mismatch).',
        '    let camDistKm = length(rel);',
        '    // Pixel world footprint (km): how much surface one pixel covers. Huge at grazing -> used',
        '    // to Nyquist-fade sub-footprint fbm octaves out of the SHADING normal (kills grazing-sun',
        '    // normal grain at the source; height/collision are untouched). dpdx/dpdy of the local',
        '    // surface pos; rotation-invariant length = world km step.',
        '    let fpKm = max(length(dpdx(rel)), length(dpdy(rel)));',
        '    // World-anchored cartesian (planet-local km) for the triplanar albedo + altitude.',
        '    // = uCamAnchor + rel (f32 is fine here: textures tile and the scales stay coarse).',
        '    let worldHi = uniforms.uCamAnchor + rel;',
        '    let altKm = length(worldHi) - CBT_RADIUS;',
        '    var nLocal = cbtNoiseNormalAt(dir, CBT_RADIUS, camDistKm, fpKm);',
        '    // Landform slope for material splatting: a SMOOTH normal at a medium camera distance',
        '    // (CBT_SLOPE_DIST) so the cm micro-relief is faded out and rock follows 30m+ hills /',
        '    // crater walls instead of speckling every per-pixel bump.',
        '    var nSlope = dir;',
        '    if ((uniforms.uPerfMask & 1) == 0) { nSlope = cbtNoiseNormalAt(dir, CBT_RADIUS, CBT_SLOPE_DIST, 0.0); }',
        '    let slope01 = clamp(1.0 - dot(nSlope, dir), 0.0, 1.0);',
        '    // Near-ground WORLD-ANCHORED micro-relief. Reconstruct the surface direction in',
        '    // df64: world = uCamAnchor + rel (the eval subtracted the SAME f32 uCamAnchor, so',
        '    // its rounding error cancels and world == the true surface point to ~um). normalize',
        '    // is radial-invariant, so dirD is the smooth-sphere unit dir the noise is defined on,',
        '    // frame-invariant (no swim) and cm-precise (no f32 banding). Gated to the near band',
        '    // for cost; outside it the cheaper f32 macro normal is used unchanged.',
        '    let dFade = 1.0 - smoothstep(CBT_GROUND_ON_KM, CBT_GROUND_OFF_KM, camDistKm);',
        '    if (dFade > 0.0 && (uniforms.uPerfMask & 2) == 0) {',
        '        let wx = df64_add(df64_from_f32(uniforms.uCamAnchor.x), df64_from_f32(rel.x));',
        '        let wy = df64_add(df64_from_f32(uniforms.uCamAnchor.y), df64_from_f32(rel.y));',
        '        let wz = df64_add(df64_from_f32(uniforms.uCamAnchor.z), df64_from_f32(rel.z));',
        '        let len2 = df64_add(df64_add(df64_mul(wx, wx), df64_mul(wy, wy)), df64_mul(wz, wz));',
        '        let inv = df64_invsqrt(len2);',
        '        let dxD = df64_mul(wx, inv);',
        '        let dyD = df64_mul(wy, inv);',
        '        let dzD = df64_mul(wz, inv);',
        '        // Macro+detail normal in df64 (kills the ~1-30 m f32 banding), blended in by the fade.',
        '        let nDf = cbtNoiseNormalAt_df64(dxD, dyD, dzD, CBT_RADIUS, camDistKm);',
        '        nLocal = normalize(mix(nLocal, nDf, dFade));',
        '        // Extra high-frequency micro-relief octaves (df64 high freq -> no banding).',
        '        let dgrad = cbtGroundDetailGrad_df64(dxD, dyD, dzD, CBT_GROUND_BASE_FREQ, CBT_GROUND_DETAIL_OCTAVES);',
        '        let tg = dgrad - dot(dgrad, nLocal) * nLocal;',
        '        nLocal = normalize(nLocal - (CBT_GROUND_STRENGTH * dFade) * tg);',
        '    }',
        '    // Diffuse normal AA: where nLocal varies fast across a pixel (sub-pixel foreground',
        '    // micro-relief), blend it toward the smooth landform normal (nSlope) so the diffuse ndl',
        '    // stops aliasing into grain. Variance-based so macro relief (slow per-pixel change) is',
        '    // preserved and the far field is not over-flattened (which exposes geometric sparkle).',
        '    let nVar = dot(dpdx(nLocal), dpdx(nLocal)) + dot(dpdy(nLocal), dpdy(nLocal));',
        '    nLocal = normalize(mix(nSlope, nLocal, 1.0 / (1.0 + CBT_NORMAL_AA * nVar)));',
        '    let nWorld = normalize((uniforms.world * vec4<f32>(nLocal, 0.0)).xyz);',
        '    // Curvature-based ambient occlusion: deviation of the SMOOTH landform normal from',
        '    // the radial direction. nSlope is at CBT_SLOPE_DIST km so micro-bumps are faded out,',
        '    // giving macro-scale AO (craters + valleys) without per-pixel noise speckling.',
        '    var ao = 1.0;',
        '    if ((uniforms.uPerfMask & 8) == 0) {',
        '        let curvature = clamp(1.0 - dot(nSlope, dir), 0.0, 1.0);',
        '        ao = 1.0 - CBT_AO_STRENGTH * curvature;',
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
        '    var refl = mix(NdL, 2.0 * ls, CBT_LUNAR_LS);',
        '    // Opposition surge: a gentle hotspot when the Sun is near the camera back (low phase).',
        '    let cosPhase = clamp(dot(V, L), -1.0, 1.0);',
        '    refl = refl * (1.0 + CBT_OPP_AMP * smoothstep(CBT_OPP_COS, 1.0, cosPhase));',
        '    // Cook-Torrance specular (D·F·G). H = half-vector. Slope-driven roughness: flat terrain',
        '    // is smoother (lower roughness) than steep slopes. NdL gate zeroes spec in shadow.',
        '    var spec = 0.0;',
        '    if ((uniforms.uPerfMask & 16) == 0) {',
        '        let H       = normalize(L + V);',
        '        let NdH     = max(dot(nWorld, H), 0.0);',
        '        let VdH     = max(dot(V, H), 0.0);',
        '        let roughness = mix(CBT_ROUGH_LO, CBT_ROUGH_HI, slope01);',
        '        let alpha   = roughness * roughness;',
        '        // Geometric specular AA (Kaplanyan): where the shading normal varies fast across a',
        '        // pixel (per-pixel micro-relief, worst at grazing toward the light) widen the GGX',
        '        // lobe by the screen-space normal variance so its sharp peak cannot alias into',
        '        // sparkle/fireflies. On smooth flats the variance ~0 so the highlight is preserved.',
        '        let dNx = dpdx(nWorld);',
        '        let dNy = dpdy(nWorld);',
        '        let varBump = CBT_SPEC_AA * (dot(dNx, dNx) + dot(dNy, dNy));',
        '        let alpha2  = clamp(alpha * alpha + varBump, 0.0, 1.0);',
        '        // GGX NDF',
        '        let denom = NdH * NdH * (alpha2 - 1.0) + 1.0;',
        '        let D = alpha2 / (3.14159 * denom * denom);',
        '        // Schlick Fresnel',
        '        let F = CBT_F0 + (1.0 - CBT_F0) * pow(1.0 - VdH, 5.0);',
        '        // Smith-GGX geometry (k = alpha/2, IBL approx) on the BASE roughness.',
        '        let k   = alpha * 0.5;',
        '        let g1L = NdL / (NdL * (1.0 - k) + k);',
        '        let g1V = NdV / (NdV * (1.0 - k) + k);',
        '        let G   = g1L * g1V;',
        '        // Firefly clamp caps any residual grazing blow-up of the (1/(4·NdL·NdV)) term.',
        '        spec = min((D * F * G) / (4.0 * NdL * NdV + 1e-4) * NdL, CBT_SPEC_MAX);',
        '    }',
        '    let lighting = uniforms.uAmbient * ao + CBT_LIGHTCOLOR * (uniforms.uLightIntensity * refl);',
        '    // Procedural albedo + slope/altitude splatting (replaces the flat CBT_ALBEDO).',
        '    var albedo = cbtGroundAlbedo(slope01, altKm);',
        '    // Broad plains/highlands brightness variation (continental scale, subtle, no swim).',
        '    albedo = albedo * (1.0 + CBT_PLAINS_AMP * cbtSimplex3_d(dir * CBT_PLAINS_FREQ).x);',
        '    // Bright ejecta rays + halos of FRESH craters (the white impact traces). Higher albedo,',
        '    // so add before lighting (still shaded). Grey -> add to all channels.',
        '    var rays = 0.0;',
        '    if ((uniforms.uPerfMask & 4) == 0) { rays = craterRays(dir, CBT_RADIUS, camDistKm); }',
        '    albedo = albedo + vec3<f32>(rays);',
        '    var finalColor = albedo * lighting + CBT_LIGHTCOLOR * (uniforms.uLightIntensity * spec);',
        '    if (uniforms.uAtmoDensity > 0.0) {',
        '        // Altitude-weighted exponential fog: dense near surface, zero above ~1% of radius.',
        '        let altFactor = clamp(1.0 - altKm / (CBT_RADIUS * 0.01), 0.0, 1.0);',
        '        let fogFactor = exp(-uniforms.uAtmoDensity * camDistKm * altFactor);',
        '        finalColor = mix(uniforms.uAtmoColor, finalColor, fogFactor);',
        '    }',
        '    fragmentOutputs.color = vec4<f32>(finalColor, 1.0);',
        '    fragmentOutputs.fragDepth = log2(fragmentInputs.vFragmentDepth) * uniforms.logarithmicDepthConstant * 0.5;',
        '    return fragmentOutputs;',
        '}'
    ].join('\n');
}

export type OcbtRenderMaterial = {
    material: ShaderMaterial;
    permBuffer: StorageBufferType;
    setLightDirection(dir: Vector3): void;
    setDebugLod(on: boolean): void;
    setPerfMask(mask: number): void;
    setCamAnchor(camLocal: Vector3): void;
    setAmbient(ambient: Vector3): void;
    setLightIntensity(intensity: number): void;
    setAtmoDensity(density: number): void;
    setAtmoColor(color: Vector3): void;
    dispose(): void;
};

/** Build the WGSL render material and bind the heap + positions + permutation buffers. */
export function buildOcbtRenderMaterial(
    scene: Scene,
    key: string,
    opts: OcbtRenderOptions,
    heapBuffer: StorageBufferType,
    positionsBuffer: StorageBufferType,
    indicesBuffer: StorageBufferType
): OcbtRenderMaterial {
    const engine = scene.getEngine() as WebGPUEngine;

    const material = new ShaderMaterial(
        `ocbt_${key}`,
        scene,
        { vertexSource: vertexSource(opts), fragmentSource: fragmentSource(opts) },
        {
            shaderLanguage: ShaderLanguage.WGSL,
            attributes: ['position'],
            uniforms: ['viewProjection', 'world', 'uLightDirection', 'logarithmicDepthConstant', 'uDebugLod', 'uPerfMask', 'uCamAnchor', 'uAmbient', 'uLightIntensity', 'uAtmoDensity', 'uAtmoColor'],
            storageBuffers: ['ocbtHeap', 'ocbtPos', 'ocbtIndices', 'cbtPerm']
        }
    );
    // Back-face culling: the octahedron is consistently wound so only the camera-facing
    // surface should draw. With it OFF, the planet's far-side / underside leaves (coarsened
    // by the backside cull, but still live and drawn) bleed THROUGH the near surface and
    // paint coarse facets over the fine foreground near the horizon. The template winding
    // (createOcbtTemplateMesh: indices [0,2,1]) makes the OUTER surface front-facing so
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
        `ocbt_perm_${key}`
    );
    permBuffer.update(permU32);

    material.setStorageBuffer('ocbtHeap', heapBuffer);
    material.setStorageBuffer('ocbtPos', positionsBuffer);
    material.setStorageBuffer('ocbtIndices', indicesBuffer);
    material.setStorageBuffer('cbtPerm', permBuffer);
    material.setVector3('uLightDirection', new Vector3(0, -1, 0));
    material.setInt('uDebugLod', 0);
    material.setInt('uPerfMask', 0);
    material.setVector3('uCamAnchor', new Vector3(0, 0, 0));
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
export function createOcbtTemplateMesh(scene: Scene, key: string): Mesh {
    const mesh = new Mesh(`ocbt_mesh_${key}`, scene);
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
