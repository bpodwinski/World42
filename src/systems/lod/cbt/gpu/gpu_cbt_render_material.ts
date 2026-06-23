/**
 * Builds the implicit-mesh CBT render material (WebGPU, WGSL). The vertex shader
 * reads the CBT heap storage buffer, decodes leaf `instanceIndex` -> heap node ->
 * LEB triangle, picks corner `vertexIndex` (0/1/2), displaces it radially by the
 * fbm height, and projects it. The fragment shader recomputes the per-pixel normal
 * from the analytic noise gradient (same field as the CPU path). No CPU geometry,
 * no per-frame upload — the mesh is fully implicit.
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
    type WebGPUEngine,
} from '@babylonjs/core';
import { buildPerm, type NoiseParams } from '../cbt_noise';
import cbtHeapRoWgsl from '../../../../assets/shaders/cbt/gpu/cbt_heap_ro.wgsl';
import cbtLebWgsl from '../../../../assets/shaders/cbt/gpu/cbt_leb.wgsl';
import cbtNoiseWgsl from '../../../../assets/shaders/cbt/gpu/cbt_noise.wgsl';

/** WGSL f32 literal (always has a decimal point). */
function f(x: number): string {
    return Number.isInteger(x) ? `${x}.0` : `${x}`;
}

export type GpuCbtRenderOptions = {
    maxDepth: number;
    radius: number;
    noise: NoiseParams;
    albedo?: Vector3;
    ambient?: Vector3;
    lightColor?: Vector3;
};

function bakedHeader(opts: GpuCbtRenderOptions): string {
    const n = opts.noise;
    const albedo = opts.albedo ?? new Vector3(0.6, 0.55, 0.4);
    const ambient = opts.ambient ?? new Vector3(0.03, 0.03, 0.03);
    const lightColor = opts.lightColor ?? new Vector3(1, 1, 1);
    return [
        `const CBT_MAX_DEPTH : u32 = ${opts.maxDepth}u;`,
        `const CBT_RADIUS : f32 = ${f(opts.radius)};`,
        `const CBT_OCTAVES : i32 = ${Math.max(0, Math.floor(n.octaves))};`,
        `const CBT_BASE_FREQ : f32 = ${f(n.baseFrequency)};`,
        `const CBT_BASE_AMP : f32 = ${f(n.baseAmplitude)};`,
        `const CBT_LACUNARITY : f32 = ${f(n.lacunarity)};`,
        `const CBT_PERSISTENCE : f32 = ${f(n.persistence)};`,
        `const CBT_GLOBAL_AMP : f32 = ${f(n.globalAmplitude)};`,
        `const CBT_ALBEDO : vec3<f32> = vec3<f32>(${f(albedo.x)}, ${f(albedo.y)}, ${f(albedo.z)});`,
        `const CBT_AMBIENT : vec3<f32> = vec3<f32>(${f(ambient.x)}, ${f(ambient.y)}, ${f(ambient.z)});`,
        `const CBT_LIGHTCOLOR : vec3<f32> = vec3<f32>(${f(lightColor.x)}, ${f(lightColor.y)}, ${f(lightColor.z)});`,
    ].join('\n');
}

function vertexSource(opts: GpuCbtRenderOptions): string {
    return [
        bakedHeader(opts),
        'var<storage, read> cbt_heap : array<u32>;',
        'var<storage, read> cbtPerm : array<u32>;',
        cbtHeapRoWgsl,
        cbtLebWgsl,
        cbtNoiseWgsl,
        'uniform worldViewProjection : mat4x4<f32>;',
        'uniform logarithmicDepthConstant : f32;',
        'varying vLocalPos : vec3<f32>;',
        'varying vFragmentDepth : f32;',
        'attribute position : vec3<f32>;',
        '@vertex',
        'fn main(input : VertexInputs) -> FragmentInputs {',
        '    let handle = vertexInputs.instanceIndex;',
        '    // Instances beyond the live leaf count collapse to a clipped degenerate',
        '    // triangle (forcedInstanceCount is a fixed cap >= the dynamic tree size).',
        '    if (handle >= cbt_nodeCount()) {',
        '        vertexOutputs.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);',
        '        vertexOutputs.vLocalPos = vec3<f32>(0.0, 0.0, 0.0);',
        '        vertexOutputs.vFragmentDepth = 1.0;',
        '        return vertexOutputs;',
        '    }',
        '    let node = cbt_decode(handle);',
        '    let tri = leb_decode(node.x, node.y);',
        '    var dir : vec3<f32>;',
        '    let vi = vertexInputs.vertexIndex;',
        '    if (vi == 0u) { dir = tri.a; } else if (vi == 1u) { dir = tri.l; } else { dir = tri.r; }',
        '    let height = cbtFbmHeight(dir);',
        '    let localPos = dir * (CBT_RADIUS + height);',
        '    vertexOutputs.position = uniforms.worldViewProjection * vec4<f32>(localPos, 1.0);',
        '    // Babylon auto-injects the WebGPU NDC-Y flip into transpiled GLSL, but NOT',
        '    // into a hand-written WGSL ShaderMaterial — so flip clip-space Y here to',
        '    // match the worker/GLSL terrain (otherwise the planet renders upside-down).',
        '    vertexOutputs.position.y = -vertexOutputs.position.y;',
        '    vertexOutputs.vLocalPos = localPos;',
        '    // Logarithmic depth (matches the other terrain materials) so the planet',
        '    // writes correct depth in front of the skybox at any distance.',
        '    vertexOutputs.vFragmentDepth = 1.0 + vertexOutputs.position.w;',
        '    vertexOutputs.position.z = log2(max(0.000001, vertexOutputs.vFragmentDepth)) * uniforms.logarithmicDepthConstant;',
        '    return vertexOutputs;',
        '}',
    ].join('\n');
}

function fragmentSource(opts: GpuCbtRenderOptions): string {
    return [
        bakedHeader(opts),
        'var<storage, read> cbtPerm : array<u32>;',
        cbtNoiseWgsl,
        'uniform world : mat4x4<f32>;',
        'uniform uLightDirection : vec3<f32>;',
        'uniform logarithmicDepthConstant : f32;',
        'varying vLocalPos : vec3<f32>;',
        'varying vFragmentDepth : f32;',
        '@fragment',
        'fn main(input : FragmentInputs) -> FragmentOutputs {',
        '    let dir = normalize(fragmentInputs.vLocalPos);',
        '    let nLocal = cbtNoiseNormal(dir, CBT_RADIUS);',
        '    let nWorld = normalize((uniforms.world * vec4<f32>(nLocal, 0.0)).xyz);',
        '    let L = normalize(-uniforms.uLightDirection);',
        '    let ndl = max(dot(nWorld, L), 0.0);',
        '    let lighting = CBT_AMBIENT + CBT_LIGHTCOLOR * ndl;',
        '    fragmentOutputs.color = vec4<f32>(CBT_ALBEDO * lighting, 1.0);',
        '    fragmentOutputs.fragDepth = log2(fragmentInputs.vFragmentDepth) * uniforms.logarithmicDepthConstant * 0.5;',
        '    return fragmentOutputs;',
        '}',
    ].join('\n');
}

export type GpuCbtRenderMaterial = {
    material: ShaderMaterial;
    permBuffer: StorageBufferType;
    setLightDirection(dir: Vector3): void;
    dispose(): void;
};

/** Build the WGSL render material and bind the heap + permutation storage buffers. */
export function buildGpuCbtRenderMaterial(
    scene: Scene,
    key: string,
    opts: GpuCbtRenderOptions,
    heapBuffer: StorageBufferType
): GpuCbtRenderMaterial {
    const engine = scene.getEngine() as WebGPUEngine;

    const material = new ShaderMaterial(
        `gpu_cbt_${key}`,
        scene,
        { vertexSource: vertexSource(opts), fragmentSource: fragmentSource(opts) },
        {
            shaderLanguage: ShaderLanguage.WGSL,
            attributes: ['position'],
            uniforms: ['worldViewProjection', 'world', 'uLightDirection', 'logarithmicDepthConstant'],
            storageBuffers: ['cbt_heap', 'cbtPerm'],
        }
    );
    // Implicit mesh has no real backface convention yet — keep both sides for now.
    material.backFaceCulling = false;

    // logarithmicDepthConstant is not auto-bound for a ShaderMaterial; refresh it
    // each bind from the active camera's far plane (mirrors cbt_terrain_shader.ts).
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
        `gpu_cbt_perm_${key}`
    );
    permBuffer.update(permU32);

    material.setStorageBuffer('cbt_heap', heapBuffer);
    material.setStorageBuffer('cbtPerm', permBuffer);
    material.setVector3('uLightDirection', new Vector3(0, -1, 0));

    return {
        material,
        permBuffer,
        setLightDirection(dir: Vector3): void {
            material.setVector3('uLightDirection', dir);
        },
        dispose(): void {
            material.dispose();
            permBuffer.dispose();
        },
    };
}

/** A 3-vertex template mesh; the implicit shader draws `forcedInstanceCount` of it. */
export function createImplicitTemplateMesh(scene: Scene, key: string): Mesh {
    const mesh = new Mesh(`gpu_cbt_mesh_${key}`, scene);
    const vd = new VertexData();
    // Dummy positions — the vertex shader ignores them (uses vertexIndex).
    vd.positions = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    vd.indices = [0, 1, 2];
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true; // procedural bounds — never frustum-cull
    return mesh;
}
