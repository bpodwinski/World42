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
};

function bakedHeader(opts: OcbtRenderOptions): string {
    const n = opts.noise;
    const albedo = opts.albedo ?? new Vector3(0.6, 0.55, 0.4);
    const ambient = opts.ambient ?? new Vector3(0.03, 0.03, 0.03);
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
        `const CBT_AMBIENT : vec3<f32> = vec3<f32>(${f(ambient.x)}, ${f(ambient.y)}, ${f(ambient.z)});`,
        `const CBT_LIGHTCOLOR : vec3<f32> = vec3<f32>(${f(lightColor.x)}, ${f(lightColor.y)}, ${f(lightColor.z)});`,
        // Near-ground detail band (world-anchored df64 micro-relief). ON/OFF in km = the
        // camera-distance fade; STRENGTH = normal-tilt amount; BASE_FREQ = first ground
        // octave's frequency on the UNIT dir (= radius / wavelength; 1 m base wavelength).
        `const CBT_GROUND_ON_KM : f32 = 0.05;`,
        `const CBT_GROUND_OFF_KM : f32 = 0.15;`,
        `const CBT_GROUND_STRENGTH : f32 = 0.03;`,
        `const CBT_GROUND_DETAIL_OCTAVES : i32 = 4;`,
        `const CBT_GROUND_BASE_FREQ : f32 = ${f(opts.radius * 1000)};`,
        // Procedural albedo splatting driven by SLOPE + ALTITUDE (physically meaningful, not
        // random color blotches): REGOLITH on flats, darker greyer ROCK on slopes, HIGHLAND
        // tint by altitude. Slope is read from the SMOOTH landform normal (CBT_SLOPE_DIST
        // fades the cm micro-relief out so rock follows 30m+ hills/crater walls, not per-pixel
        // bumps). SLOPE_* are in slope units = 1 - dot(landformNormal, up); 0 = flat.
        ...(() => {
            const g = (albedo.x + albedo.y + albedo.z) / 3;
            const rk = (c: number) => 0.45 * (0.5 * c + 0.5 * g); // darker + desaturated
            return [
                `const CBT_REGOLITH : vec3<f32> = vec3<f32>(${f(albedo.x)}, ${f(albedo.y)}, ${f(albedo.z)});`,
                `const CBT_ROCK : vec3<f32> = vec3<f32>(${f(rk(albedo.x))}, ${f(rk(albedo.y))}, ${f(rk(albedo.z))});`
            ];
        })(),
        `const CBT_HIGHLAND_TINT : vec3<f32> = vec3<f32>(1.12, 1.12, 1.16);`,
        `const CBT_SLOPE_LO : f32 = 0.03;`,
        `const CBT_SLOPE_HI : f32 = 0.22;`,
        `const CBT_SLOPE_DIST : f32 = 2.0;`,
        `const CBT_ALT_LO : f32 = ${f(opts.noise.globalAmplitude * 0.25)};`,
        `const CBT_ALT_HI : f32 = ${f(opts.noise.globalAmplitude * 0.65)};`
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
        // Camera position in planet-local sim units (= the SAME f32 value the df64 eval
        // subtracted to make `rel`). world = uCamAnchor + rel reconstructs the surface point
        // exactly (the camera's f32 rounding cancels), giving a frame-invariant, cm-precise
        // direction for the ground detail noise (no swim, no banding).
        'uniform uCamAnchor : vec3<f32>;',
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
        '    // World-anchored cartesian (planet-local km) for the triplanar albedo + altitude.',
        '    // = uCamAnchor + rel (f32 is fine here: textures tile and the scales stay coarse).',
        '    let worldHi = uniforms.uCamAnchor + rel;',
        '    let altKm = length(worldHi) - CBT_RADIUS;',
        '    var nLocal = cbtNoiseNormalAt(dir, CBT_RADIUS, camDistKm);',
        '    // Landform slope for material splatting: a SMOOTH normal at a medium camera distance',
        '    // (CBT_SLOPE_DIST) so the cm micro-relief is faded out and rock follows 30m+ hills /',
        '    // crater walls instead of speckling every per-pixel bump.',
        '    let nSlope = cbtNoiseNormalAt(dir, CBT_RADIUS, CBT_SLOPE_DIST);',
        '    let slope01 = clamp(1.0 - dot(nSlope, dir), 0.0, 1.0);',
        '    // Near-ground WORLD-ANCHORED micro-relief. Reconstruct the surface direction in',
        '    // df64: world = uCamAnchor + rel (the eval subtracted the SAME f32 uCamAnchor, so',
        '    // its rounding error cancels and world == the true surface point to ~um). normalize',
        '    // is radial-invariant, so dirD is the smooth-sphere unit dir the noise is defined on,',
        '    // frame-invariant (no swim) and cm-precise (no f32 banding). Gated to the near band',
        '    // for cost; outside it the cheaper f32 macro normal is used unchanged.',
        '    let dFade = 1.0 - smoothstep(CBT_GROUND_ON_KM, CBT_GROUND_OFF_KM, camDistKm);',
        '    if (dFade > 0.0) {',
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
        '    let nWorld = normalize((uniforms.world * vec4<f32>(nLocal, 0.0)).xyz);',
        '    let L = normalize(-uniforms.uLightDirection);',
        '    let ndl = max(dot(nWorld, L), 0.0);',
        '    let lighting = CBT_AMBIENT + CBT_LIGHTCOLOR * ndl;',
        '    // Procedural albedo + slope/altitude splatting (replaces the flat CBT_ALBEDO).',
        '    let albedo = cbtGroundAlbedo(slope01, altKm);',
        '    fragmentOutputs.color = vec4<f32>(albedo * lighting, 1.0);',
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
    setCamAnchor(camLocal: Vector3): void;
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
            uniforms: ['viewProjection', 'world', 'uLightDirection', 'logarithmicDepthConstant', 'uDebugLod', 'uCamAnchor'],
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
    material.setVector3('uCamAnchor', new Vector3(0, 0, 0));

    return {
        material,
        permBuffer,
        setLightDirection(dir: Vector3): void {
            material.setVector3('uLightDirection', dir);
        },
        setDebugLod(on: boolean): void {
            material.setInt('uDebugLod', on ? 1 : 0);
        },
        setCamAnchor(camLocal: Vector3): void {
            material.setVector3('uCamAnchor', camLocal);
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
