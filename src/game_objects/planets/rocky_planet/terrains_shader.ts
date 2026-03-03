import {
    Effect,
    Matrix,
    RawTexture,
    RenderTargetTexture,
    Scene,
    ShaderMaterial,
    ShadowGenerator,
    Vector2,
    Vector3,
} from '@babylonjs/core';
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
    lightMatrix: Matrix;
    texelSize: Vector2;
    bias: number;
    normalBias: number;
    darkness: number;
    reverseDepth: number;
};

type TerrainSceneMetadata = {
    terrainLighting?: {
        starPosWorldDouble: Vector3;
        intensity: number;
    };
    terrainShadow?: TerrainShadowContext | null;
};

function getTerrainSceneMetadata(scene: Scene): TerrainSceneMetadata {
    if (!scene.metadata || typeof scene.metadata !== 'object') {
        scene.metadata = {};
    }
    return scene.metadata as TerrainSceneMetadata;
}

export class TerrainShader {
    private scene: Scene;

    private static _texCache = new WeakMap<Scene, { diffuse: TextureManager; detail: TextureManager }>();
    private static _dummyShadow = new WeakMap<Scene, RawTexture>();

    private static getDummyShadow(scene: Scene): RawTexture {
        const cached = this._dummyShadow.get(scene);
        if (cached) return cached;

        const tex = new RawTexture(
            new Uint8Array([255, 255, 255, 255]),
            1,
            1,
            5,
            scene,
            false,
            false
        );
        this._dummyShadow.set(scene, tex);
        return tex;
    }

    constructor(scene: Scene) {
        this.scene = scene;
    }

    public static setPrimaryStarWorldDouble(
        scene: Scene,
        starPosWorldDouble: Vector3,
        intensity: number = 1.0
    ) {
        const metadata = getTerrainSceneMetadata(scene);
        metadata.terrainLighting = {
            starPosWorldDouble: starPosWorldDouble.clone(),
            intensity,
        };
    }

    public static setTerrainShadowContext(scene: Scene, ctx: TerrainShadowContext | null) {
        const metadata = getTerrainSceneMetadata(scene);
        metadata.terrainShadow = ctx;
    }

    public static getTerrainShadowContext(scene: Scene): TerrainShadowContext | null {
        return getTerrainSceneMetadata(scene).terrainShadow ?? null;
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
                    'time',
                    'amplitude',
                    'frequency',
                    'mesh_dim',
                    'lodLevel',
                    'lodMaxLevel',
                    'lodRangesLUT',
                    'cameraPosition',
                    'uPlanetCenter',
                    'uPatchCenter',
                    'debugUV',
                    'debugLOD',
                    'textureScale',
                    'detailScale',
                    'detailBlend',
                    'lightDirection',
                    'lightColor',
                    'lightIntensity',
                    'lightMatrix',
                    'shadowBias',
                    'shadowNormalBias',
                    'shadowDarkness',
                    'shadowTexelSize',
                    'shadowReverseDepth',
                    'shadowNdcHalfZRange',
                ],
                samplers: ['diffuseTexture', 'detailTexture', 'shadowSampler'],
            }
        );

        shader.setInt('debugLOD', debugLOD ? 1 : 0);
        shader.setInt('debugUV', 0);
        shader.setFloat('time', 0);
        shader.setFloat('amplitude', 0);
        shader.setFloat('frequency', 0);
        shader.setFloat('mesh_dim', resolution);
        shader.setFloat('lodLevel', lodLevel);
        shader.setFloat('lodMaxLevel', maxLevel);
        shader.setVector3('cameraPosition', cameraPositionLocal);

        const lodRanges: number[] = [];
        for (let i = 0; i < maxLevel; i++) {
            lodRanges[i] = planetRadius * Math.pow(2, i);
        }
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
        shader.setFloat('lightIntensity', 1);

        shader.setMatrix('lightMatrix', Matrix.Identity());
        shader.setFloat('shadowBias', 0.0005);
        shader.setFloat('shadowNormalBias', 0.0015);
        shader.setFloat('shadowDarkness', 1);
        shader.setVector2('shadowTexelSize', new Vector2(1, 1));
        shader.setFloat('shadowReverseDepth', 0);
        shader.setTexture('shadowSampler', TerrainShader.getDummyShadow(this.scene));

        shader.onBindObservable.add(() => {
            const ctx = TerrainShader.getTerrainShadowContext(this.scene);
            if (!ctx) return;

            shader.setTexture('shadowSampler', ctx.shadowMap);
            shader.setMatrix('lightMatrix', ctx.lightMatrix);
            shader.setVector2('shadowTexelSize', ctx.texelSize);
            shader.setFloat('shadowBias', ctx.bias);
            shader.setFloat('shadowNormalBias', ctx.normalBias);
            shader.setFloat('shadowDarkness', ctx.darkness);

            const engine = this.scene.getEngine();
            shader.setFloat('shadowReverseDepth', engine.useReverseDepthBuffer ? 1 : 0);
            shader.setFloat('shadowNdcHalfZRange', engine.isNDCHalfZRange ? 1 : 0);
        });

        shader.wireframe = wireframe;
        return shader;
    }
}
