import { Effect, Scene, ShaderMaterial, Vector2, Vector3, Matrix, ShadowGenerator, RenderTargetTexture, RawTexture } from '@babylonjs/core';
import terrainDebugLODShader from '../../../assets/shaders/terrain/_terrainDebugLOD.glsl';
import terrainVertexShader from '../../../assets/shaders/terrain/terrainVertexShader.glsl';
import terrainFragmentShader from '../../../assets/shaders/terrain/terrainFragmentShader.glsl';
import { TextureManager } from '../../../core/io/texture_manager';

Effect.IncludesShadersStore['debugLOD'] = terrainDebugLODShader;
Effect.ShadersStore['terrainVertexShader'] = terrainVertexShader;
Effect.ShadersStore['terrainFragmentShader'] = terrainFragmentShader;

export type TerrainShadowContext = {
    shadowGen: ShadowGenerator;
    shadowMap: RenderTargetTexture;
    lightMatrix: Matrix;     // mis à jour 1x/frame (Render-space)
    texelSize: Vector2;      // 1 / mapSize
    bias: number;            // bias en [0..1]
    darkness: number;        // 0..1 (1 = ombre full)
    reverseDepth: number;    // 0 ou 1
};

export class TerrainShader {
    private scene: Scene;

    private static _texCache = new WeakMap<Scene, { diffuse: TextureManager; detail: TextureManager }>();

    private static _dummyShadow = new WeakMap<Scene, RawTexture>();

    private static getDummyShadow(scene: Scene): RawTexture {
        const cached = this._dummyShadow.get(scene);
        if (cached) return cached;

        // 1x1 blanc => depth=1.0 => "pas d’ombre"
        const tex = new RawTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 5 /* RGBA */, scene, false, false);
        this._dummyShadow.set(scene, tex);
        return tex;
    }

    constructor(scene: Scene) {
        this.scene = scene;
    }

    public static setPrimaryStarWorldDouble(scene: Scene, starPosWorldDouble: Vector3, intensity: number = 1.0) {
        scene.metadata = scene.metadata ?? {};
        scene.metadata.terrainLighting = { starPosWorldDouble: starPosWorldDouble.clone(), intensity };
    }

    /** Contexte d’ombre partagé (P0) */
    public static setTerrainShadowContext(scene: Scene, ctx: TerrainShadowContext | null) {
        scene.metadata = scene.metadata ?? {};
        (scene.metadata as any).terrainShadow = ctx;
    }

    public static getTerrainShadowContext(scene: Scene): TerrainShadowContext | null {
        return ((scene.metadata as any)?.terrainShadow ?? null) as TerrainShadowContext | null;
    }

    private static getTextures(scene: Scene) {
        const cached = this._texCache.get(scene);
        if (cached) return cached;

        const tex = {
            diffuse: new TextureManager('terrain_diffuse.ktx2', scene),
            detail: new TextureManager('terrain_detail.ktx2', scene),
        };
        this._texCache.set(scene, tex);
        return tex;
    }

    /**
     * Create a terrain ShaderMaterial for one chunk.
     *
     * All spatial parameters are in **planet-local** space (origin = planet center,
     * axes = pre-rotation). The caller (ChunkForge) converts from WorldDouble before calling.
     *
     * @param resolution       Grid resolution of the terrain patch.
     * @param lodLevel         Current LOD level of this chunk.
     * @param maxLevel         Maximum LOD level in the quadtree.
     * @param cameraPositionLocal Camera position in **planet-local** (sim units).
     * @param planetRadius     Planet radius in **simulation units** (km * SCALE_FACTOR).
     * @param patchCenterLocal Patch center in **planet-local** (sim units).
     * @param wireframe        Enable wireframe rendering.
     * @param debugLOD         Enable LOD debug coloring.
     */
    create(
        resolution: number,
        lodLevel: number,
        maxLevel: number,
        cameraPositionLocal: Vector3,
        planetRadius: number,
        patchCenterLocal: Vector3,
        wireframe: boolean = false,
        debugLOD: boolean = false
    ): ShaderMaterial {
        const shader = new ShaderMaterial(
            'terrainShader',
            this.scene,
            { vertex: 'terrain', fragment: 'terrain' },
            {
                attributes: ['position', 'normal', 'uv'],
                uniforms: [
                    'worldViewProjection',
                    'world',

                    'time', 'amplitude', 'frequency',
                    'mesh_dim',
                    'lodLevel', 'lodMaxLevel', 'lodRangesLUT',
                    'cameraPosition',
                    'uPlanetCenter', 'uPatchCenter',
                    'debugUV', 'debugLOD',

                    'textureScale',
                    'detailScale',
                    'detailBlend',

                    'lightDirection',
                    'lightColor',
                    'lightIntensity',

                    // Shadows (P0)
                    'lightMatrix',
                    'shadowBias',
                    'shadowDarkness',
                    'shadowTexelSize',
                    'shadowReverseDepth',
                    "shadowNdcHalfZRange",
                ],
                samplers: ['diffuseTexture', 'detailTexture', 'shadowSampler'],
            }
        );

        shader.setInt('debugLOD', debugLOD ? 1 : 0);
        shader.setInt('debugUV', 0);

        shader.setFloat('time', 0.0);
        shader.setFloat('amplitude', 0.0);
        shader.setFloat('frequency', 0.0);

        shader.setFloat('mesh_dim', resolution);
        shader.setFloat('lodLevel', lodLevel);
        shader.setFloat('lodMaxLevel', maxLevel);
        shader.setVector3('cameraPosition', cameraPositionLocal);

        const lodRanges: number[] = [];
        for (let i = 0; i < maxLevel; i++) lodRanges[i] = planetRadius * Math.pow(2, i);
        shader.setFloats('lodRangesLUT', lodRanges);

        shader.setVector3('uPlanetCenter', Vector3.Zero());
        shader.setVector3('uPatchCenter', patchCenterLocal);

        const tex = TerrainShader.getTextures(this.scene);
        shader.setTexture('diffuseTexture', tex.diffuse);
        shader.setFloat('textureScale', 0.0001);

        shader.setTexture('detailTexture', tex.detail);
        shader.setFloat('detailScale', 0.1);
        shader.setFloat('detailBlend', 0.5);

        shader.setVector3('lightDirection', new Vector3(1, 0, 0));
        shader.setVector3('lightColor', new Vector3(1, 1, 1));
        shader.setFloat('lightIntensity', 1.0);

        // Shadows defaults + bind dummy to satisfy WebGPU
        shader.setMatrix('lightMatrix', Matrix.Identity());
        shader.setFloat('shadowBias', 0.0005);
        shader.setFloat('shadowDarkness', 1.0);
        shader.setVector2('shadowTexelSize', new Vector2(1.0, 1.0));
        shader.setFloat('shadowReverseDepth', 0.0);
        shader.setTexture('shadowSampler', TerrainShader.getDummyShadow(this.scene));

        // If scene.metadata.terrainShadow exists, override at bind time
        shader.onBindObservable.add(() => {
            const ctx = TerrainShader.getTerrainShadowContext(this.scene);
            if (!ctx) return;

            shader.setTexture("shadowSampler", ctx.shadowMap);       // IMPORTANT: shadowMapForRendering en WebGPU
            shader.setMatrix("lightMatrix", ctx.lightMatrix);
            shader.setVector2("shadowTexelSize", ctx.texelSize);
            shader.setFloat("shadowBias", ctx.bias);
            shader.setFloat("shadowDarkness", ctx.darkness);

            const eng = this.scene.getEngine();
            shader.setFloat("shadowReverseDepth", eng.useReverseDepthBuffer ? 1 : 0);
            shader.setFloat("shadowNdcHalfZRange", eng.isNDCHalfZRange ? 1 : 0);
        });

        shader.wireframe = wireframe;

        return shader;
    }
}
