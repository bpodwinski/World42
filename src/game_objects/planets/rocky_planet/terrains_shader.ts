import { Effect, Scene, ShaderMaterial, Vector3 } from '@babylonjs/core';
import { ScaleManager } from '../../../core/scale/scale_manager';

import terrainDebugLODShader from '../../../assets/shaders/terrain/_terrainDebugLOD.glsl';
import terrainVertexShader from '../../../assets/shaders/terrain/terrainVertexShader.glsl';
import terrainFragmentShader from '../../../assets/shaders/terrain/terrainFragmentShader.glsl';
import { TextureManager } from '../../../core/io/texture_manager';
import { PlanetData } from '../../../game_world/solar_system/planet_data';

Effect.IncludesShadersStore['debugLOD'] = terrainDebugLODShader;
Effect.ShadersStore['terrainVertexShader'] = terrainVertexShader;
Effect.ShadersStore['terrainFragmentShader'] = terrainFragmentShader;

/**
 * TerrainShader creates and configures ShaderMaterial for terrain rendering
 *
 * Centralizes shader configuration and makes it reusable across terrain chunks
 */
export class TerrainShader {
    private scene: Scene;

    /**
     * Creates new TerrainShader instance using provided scene
     *
     * @param {Scene} scene - Babylon.js scene for shader creation
     */
    constructor(scene: Scene) {
        this.scene = scene;
    }

    /**
     * Creates and configures a ShaderMaterial for terrain rendering
     *
     * @param {number} resolution - Grid resolution for terrain chunk
     * @param {number} lodLevel - Current level of detail
     * @param {number} maxLevel - Maximum level of detail
     * @param {Vector3} cameraPosition - Camera position in world space
     * @param {number} planetRadius - Radius of the planet
     * @param {Vector3} planetCenter - Center position of the planet
     * @param {boolean} [wireframe=false] - Enable or disable wireframe mode
     * @param {boolean} [debugLOD=false] - Enable or disable debug mode for LOD
     * @returns {ShaderMaterial} Configured ShaderMaterial for terrain
     */
    create(
        resolution: number,
        lodLevel: number,
        maxLevel: number,
        cameraPosition: Vector3,
        planetRadius: number,
        planetCenter: Vector3,
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
                    'lodRangesLUT',
                    'cameraPosition',
                    'uPlanetCenter',
                    'showUV',
                    'debugUV',
                    'lightDirection'
                ],
                samplers: ['diffuseTexture', 'detailTexture']
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
            lodRanges[i] =
                ScaleManager.toSimulationUnits(planetRadius) * Math.pow(2, i);
        }
        shader.setFloats('lodRangesLUT', lodRanges);
        shader.setVector3('uPlanetCenter', planetCenter);

        // Diffuse
        shader.setTexture(
            'diffuseTexture',
            new TextureManager('terrain_diffuse.ktx2', this.scene)
        );
        shader.setFloat('textureScale', 0.0001);

        // Detail
        shader.setTexture(
            'detailTexture',
            new TextureManager('terrain_detail.ktx2', this.scene)
        );
        shader.setFloat('detailScale', 1.0);
        shader.setFloat('detailBlend', 0.5);

        // Light
        shader.setVector3(
            'lightDirection',
            PlanetData.get('Sun').position.subtract(planetCenter).normalize()
        );
        shader.setFloat('lightIntensity', 1.0);

        shader.wireframe = wireframe;

        return shader;
    }
}
