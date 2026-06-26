/**
 * GPU-driven starfield renderer — replaces the static cubemap skybox with physically-
 * based star billboards driven by the pre-processed HYG catalog.
 *
 * Rendering model:
 *   - One GPU instance per catalog star (forcedInstanceCount = N).
 *   - Template mesh: 4-vertex quad (indices [0,1,2, 0,2,3]).  The vertex shader reads
 *     star data (ra, dec, mag, bv) from a StorageBuffer using instanceIndex.
 *   - Billboard size ∝ apparent magnitude; color from B-V index (vertex shader).
 *   - Isotropic Gaussian PSF in the fragment shader; bloom amplifies bright star halos.
 *   - ALPHA_ADD blending: stars accumulate on the cleared black background.
 *   - No depth write; NDC z = 0.9999 → depth test passes for sky (cleared to 1.0) and
 *     fails for terrain (log-encoded depth < 0.9999).
 *
 * StorageBuffer layout: array<vec4<f32>>, one vec4 per star: [ra, dec, mag, bv].
 * Matches the binary produced by tools/hyg_to_binary.py.
 */
import {
    Constants,
    Mesh,
    ShaderLanguage,
    ShaderMaterial,
    StorageBuffer,
    Vector2,
    VertexData,
    type Scene,
    type WebGPUEngine
} from '@babylonjs/core';
import type { StarCatalogData } from '../io/star_catalog';
import starfieldVertexShader from '../../assets/shaders/stars/starfieldVertexShader.wgsl';
import starfieldFragmentShader from '../../assets/shaders/stars/starfieldFragmentShader.wgsl';

export type StarfieldHandle = {
    dispose: () => void;
};

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
    // createOcbtTemplateMesh in ocbt_render_material.ts).
    const mesh = new Mesh('starfield', scene);
    const vd = new VertexData();
    vd.positions = [0, 0, 0,  0, 0, 0,  0, 0, 0,  0, 0, 0];  // 4 × vec3 dummies
    vd.indices = [0, 1, 2,  0, 2, 3];
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;  // no frustum cull (stars span the full sky)
    mesh.isPickable = false;
    mesh.renderingGroupId = 0;             // render before terrain (group 1+) when separated
    mesh.forcedInstanceCount = catalog.count;

    // Upload star data as a StorageBuffer.
    // catalog.buffer = Float32Array([ra0, dec0, mag0, bv0, ra1, ...]).
    // Layout matches array<vec4<f32>> in the WGSL vertex shader.
    const starBuffer = new StorageBuffer(
        engine,
        catalog.buffer.byteLength,
        Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_WRITE,
        'starfield_data'
    );
    starBuffer.update(catalog.buffer);

    const material = new ShaderMaterial(
        'starfield_mat',
        scene,
        { vertexSource: starfieldVertexShader, fragmentSource: starfieldFragmentShader },
        {
            shaderLanguage: ShaderLanguage.WGSL,
            attributes: ['position'],
            uniforms: ['viewProjection', 'viewport'],
            storageBuffers: ['starData']
        }
    );

    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    // Additive blending: star HDR contribution accumulates on the cleared black background.
    material.alphaMode = Constants.ALPHA_ADD;

    material.setStorageBuffer('starData', starBuffer);

    // Update viewport size each frame (handles canvas resize gracefully).
    const _viewport = new Vector2();
    material.onBindObservable.add(() => {
        _viewport.set(engine.getRenderWidth(), engine.getRenderHeight());
        material.setVector2('viewport', _viewport);
    });

    mesh.material = material;

    return {
        dispose(): void {
            mesh.dispose();
            material.dispose();
            starBuffer.dispose();
        }
    };
}
