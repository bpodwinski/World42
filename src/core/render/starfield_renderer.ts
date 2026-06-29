/**
 * GPU-driven starfield renderer — replaces the static cubemap skybox with physically-
 * based star billboards driven by the pre-processed HYG catalog.
 *
 * Rendering model:
 *   - One GPU instance per catalog star (forcedInstanceCount = N).
 *   - Template mesh: 4-vertex quad (indices [0,1,2, 0,2,3]).  The vertex shader reads
 *     star data (ra, dec, mag, bv) from a StorageBuffer using instanceIndex.
 *   - Billboard size ∝ apparent magnitude; color from B-V index (precomputed on CPU).
 *   - Bounded human-eye PSF in the fragment shader; bloom amplifies bright star halos.
 *   - ALPHA_ADD blending: stars accumulate on the cleared black background.
 *   - No depth write; NDC z = 0.9999 → depth test passes for sky (cleared to 1.0) and
 *     fails for terrain (log-encoded depth < 0.9999).
 *
 * StorageBuffers:
 *   starData  — array<vec4<f32>> [ra, dec, mag, bv] per star (from binary catalog).
 *   starColors — array<vec4<f32>> [r, g, b, baseRadius] per star (precomputed once on CPU).
 *
 * The starColors buffer moves the expensive bvToLinearRgb polynomial and baseRadius
 * computation off the GPU (where they ran 4× per star per frame) to a one-time CPU pass
 * at load time, cutting vertex shader cost significantly for large catalogs.
 */
import {
    Constants,
    Mesh,
    ShaderLanguage,
    ShaderMaterial,
    StorageBuffer,
    Vector2,
    Vector3,
    VertexData,
    type Scene,
    type WebGPUEngine
} from '@babylonjs/core';
import type { StarCatalogData } from '../io/star_catalog';
import starfieldVertexShader from '../../assets/shaders/stars/starfieldVertexShader.wgsl';
import starfieldFragmentShader from '../../assets/shaders/stars/starfieldFragmentShader.wgsl';

export type StarfieldHandle = {
    dispose: () => void;
    /**
     * Update atmospheric scintillation state each frame.
     * @param factor  0 = space / airless body (no scintillation), 1 = at surface.
     * @param worldUp Normalised direction from planet centre to camera (surface normal).
     */
    setAtmosphereState: (factor: number, worldUp: Vector3) => void;
};

/**
 * B-V color index → linear sRGB (D65, IEC 61966-2-1), normalized to peak = 1.
 *
 * Pipeline: B-V → T_eff (Ballesteros 2012) → CIE 1931 xy (Kang et al. 2002 Planckian
 * locus) → XYZ → linear sRGB. Mirrors bvToLinearRgb() in the WGSL vertex shader but
 * runs once per star at load time instead of 4× per star per frame on the GPU.
 */
function bvToLinearRgb(bv: number): [number, number, number] {
    const t = Math.max(-0.4, Math.min(2.0, bv));
    const T = 4600 * (1 / (0.92 * t + 1.7) + 1 / (0.92 * t + 0.62));
    const T2 = T * T, T3 = T2 * T;
    let x: number;
    if (T < 4000) {
        x = -2.661239e8 / T3 - 2.343580e5 / T2 + 8.776956e2 / T + 0.179910;
    } else {
        x = -3.025847e9 / T3 + 2.107038e6 / T2 + 2.226347e2 / T + 0.240390;
    }
    let y: number;
    if (T < 2222) {
        y = -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683;
    } else if (T < 4000) {
        y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
    } else {
        y =  3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
    }
    const X = x / y;
    const Z = (1 - x - y) / y;
    const r = Math.max(0,  3.2404542 * X - 1.5371385             - 0.4985314 * Z);
    const g = Math.max(0, -0.9692660 * X + 1.8760108             + 0.0415560 * Z);
    const b = Math.max(0,  0.0556434 * X - 0.2040259             + 1.0572252 * Z);
    const peak = Math.max(r, g, b, 1e-5);
    return [r / peak, g / peak, b / peak];
}

/**
 * Precompute per-star [r, g, b, baseRadius] and pack into a Float32Array.
 * baseRadius uses the same flux^0.31 formula as the WGSL vertex shader.
 */
function buildStarColorsBuffer(catalog: StarCatalogData): Float32Array {
    const out = new Float32Array(catalog.count * 4);
    for (let i = 0; i < catalog.count; i++) {
        const base = i * 4;
        const mag = catalog.buffer[base + 2];
        const bv  = catalog.buffer[base + 3];

        const [r, g, b] = bvToLinearRgb(bv);
        const flux = Math.pow(10, -0.4 * mag);
        const baseRadius = Math.max(0.6, Math.min(12.0, 7.0 * Math.pow(flux, 0.31)));

        out[base]     = r;
        out[base + 1] = g;
        out[base + 2] = b;
        out[base + 3] = baseRadius;
    }
    return out;
}

/**
 * Creates the GPU-driven starfield and attaches it to the scene.
 * The mesh participates in the FrameGraphObjectRendererTask automatically
 * (scene.meshes is updated by the Mesh constructor).
 */
export function createStarfieldRenderer(
    scene: Scene,
    catalog: StarCatalogData
): StarfieldHandle {
    const engine = scene.getEngine() as WebGPUEngine;

    // Four-vertex quad template. Positions are all-zero dummies: the vertex shader
    // derives world-space positions from the StorageBuffer (identical pattern to
    // createTerrainTemplateMesh in terrain_render_material.ts).
    const mesh = new Mesh('starfield', scene);
    const vd = new VertexData();
    vd.positions = [0, 0, 0,  0, 0, 0,  0, 0, 0,  0, 0, 0];  // 4 × vec3 dummies
    vd.indices = [0, 1, 2,  0, 2, 3];
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;  // no frustum cull (stars span the full sky)
    mesh.isPickable = false;
    mesh.renderingGroupId = 0;             // render before terrain (group 1+) when separated
    mesh.forcedInstanceCount = catalog.count;

    // Upload star positional data (ra, dec, mag, bv) — used at runtime for direction + scintillation.
    const starBuffer = new StorageBuffer(
        engine,
        catalog.buffer.byteLength,
        Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_WRITE,
        'starfield_data'
    );
    starBuffer.update(catalog.buffer);

    // Precompute per-star [r, g, b, baseRadius] on the CPU (one-time at load).
    // This replaces the bvToLinearRgb polynomial + baseRadius computation that previously
    // ran in the vertex shader 4× per star per frame, causing heavy GPU divergence.
    const colorsData = buildStarColorsBuffer(catalog);
    const colorsBuffer = new StorageBuffer(
        engine,
        colorsData.byteLength,
        Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_WRITE,
        'starfield_colors'
    );
    colorsBuffer.update(colorsData);

    const material = new ShaderMaterial(
        'starfield_mat',
        scene,
        { vertexSource: starfieldVertexShader, fragmentSource: starfieldFragmentShader },
        {
            shaderLanguage: ShaderLanguage.WGSL,
            attributes: ['position'],
            uniforms: ['viewProjection', 'viewport', 'time', 'worldUp', 'atmosphereFactor'],
            storageBuffers: ['starData', 'starColors']
        }
    );

    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    // Additive blending: star HDR contribution accumulates on the cleared black background.
    material.alphaMode = Constants.ALPHA_ADD;

    material.setStorageBuffer('starData', starBuffer);
    material.setStorageBuffer('starColors', colorsBuffer);

    // Mutable atmosphere state updated by the caller via setAtmosphereState().
    const _worldUp = new Vector3(0, 1, 0);
    let _atmosphereFactor = 0;

    // Update per-frame uniforms (viewport size, time, atmosphere state).
    const _viewport = new Vector2();
    material.onBindObservable.add(() => {
        _viewport.set(engine.getRenderWidth(), engine.getRenderHeight());
        material.setVector2('viewport', _viewport);
        material.setFloat('time', performance.now() / 1000);
        material.setVector3('worldUp', _worldUp);
        material.setFloat('atmosphereFactor', _atmosphereFactor);
    });

    mesh.material = material;

    return {
        dispose(): void {
            mesh.dispose();
            material.dispose();
            starBuffer.dispose();
            colorsBuffer.dispose();
        },
        setAtmosphereState(factor: number, worldUp: Vector3): void {
            _atmosphereFactor = Math.max(0, Math.min(1, factor));
            _worldUp.copyFrom(worldUp);
        }
    };
}
