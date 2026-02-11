import { Effect, Scene, ShaderMaterial, Vector3 } from '@babylonjs/core';
import terrainDebugLODShader from '../../../assets/shaders/terrain/_terrainDebugLOD.glsl';
import terrainVertexShader from '../../../assets/shaders/terrain/terrainVertexShader.glsl';
import terrainFragmentShader from '../../../assets/shaders/terrain/terrainFragmentShader.glsl';
import { TextureManager } from '../../../core/io/texture_manager';

Effect.IncludesShadersStore['debugLOD'] = terrainDebugLODShader;
Effect.ShadersStore['terrainVertexShader'] = terrainVertexShader;
Effect.ShadersStore['terrainFragmentShader'] = terrainFragmentShader;

/**
 * TerrainShader creates and configures ShaderMaterial for terrain rendering
 */
export class TerrainShader {
    private scene: Scene;

    // Cache textures per-scene to avoid re-creating them for every chunk material
    private static _texCache = new WeakMap<Scene, { diffuse: TextureManager; detail: TextureManager }>();

    constructor(scene: Scene) {
        this.scene = scene;
    }

    /**
     * Optional: set the primary star position for lighting (WorldDouble, simulation units)
     * Store it in scene.metadata to avoid globals like PlanetData.
     */
    public static setPrimaryStarWorldDouble(scene: Scene, starPosWorldDouble: Vector3, intensity: number = 1.0) {
        scene.metadata = scene.metadata ?? {};
        scene.metadata.terrainLighting = {
            starPosWorldDouble: starPosWorldDouble.clone(),
            intensity,
        };
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
     * Creates and configures a ShaderMaterial for terrain rendering
     *
     * @param cameraPosition - Camera position in WorldDouble (simulation units)
     * @param planetCenter - Planet center in WorldDouble (simulation units)
     * @param patchCenterLocal - Center of the patch in planet-local space (before rotation)
     */
    create(
        resolution: number,
        lodLevel: number,
        maxLevel: number,
        cameraPosition: Vector3,
        planetRadius: number,
        planetCenter: Vector3,
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
                    "lightColor",
                    'lightIntensity',
                ],
                samplers: ['diffuseTexture', 'detailTexture'],
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
        shader.setVector3('cameraPosition', cameraPosition);

        const lodRanges: number[] = [];
        for (let i = 0; i < maxLevel; i++) {
            lodRanges[i] = planetRadius * Math.pow(2, i);
        }
        shader.setFloats('lodRangesLUT', lodRanges);

        // Mesh vertices are in planet-local space (origin = planet center)
        shader.setVector3('uPlanetCenter', Vector3.Zero());
        shader.setVector3('uPatchCenter', patchCenterLocal);

        // Textures (cached)
        const tex = TerrainShader.getTextures(this.scene);
        shader.setTexture('diffuseTexture', tex.diffuse);
        shader.setFloat('textureScale', 0.0001);

        shader.setTexture('detailTexture', tex.detail);
        shader.setFloat('detailScale', 0.1);
        shader.setFloat('detailBlend', 0.5);

        // Lighting: compute direction from a per-scene "primary star" if provided
        const meta = (this.scene.metadata as any)?.terrainLighting;
        const starPosWorldDouble: Vector3 | undefined = meta?.starPosWorldDouble;
        const intensity: number = Number.isFinite(meta?.intensity) ? meta.intensity : 10.0;

        const lightDir = new Vector3(1, 0, 0);
        if (starPosWorldDouble) {
            starPosWorldDouble.subtractToRef(planetCenter, lightDir);
            planetCenter.subtractToRef(starPosWorldDouble, lightDir);
            if (lightDir.lengthSquared() < 1e-12) {
                lightDir.set(1, 0, 0);
            } else {
                lightDir.normalize();
            }
        }
        shader.setVector3('lightDirection', lightDir);
        shader.setVector3("lightColor", new Vector3(1, 1, 1));
        shader.setFloat('lightIntensity', intensity);

        shader.wireframe = wireframe;
        return shader;
    }
}
