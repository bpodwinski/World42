import { Effect, ShaderMaterial, Vector3, type Scene } from '@babylonjs/core';
import { buildPerm, DEFAULT_NOISE, type NoiseParams } from './cbt_noise';
import cbtNoiseShader from '../../../assets/shaders/cbt/_cbtNoise.glsl';
import cbtTerrainVertexShader from '../../../assets/shaders/cbt/cbtTerrainVertexShader.glsl';
import cbtTerrainFragmentShader from '../../../assets/shaders/cbt/cbtTerrainFragmentShader.glsl';

Effect.IncludesShadersStore['cbtNoise'] = cbtNoiseShader;
Effect.ShadersStore['cbtTerrainVertexShader'] = cbtTerrainVertexShader;
Effect.ShadersStore['cbtTerrainFragmentShader'] = cbtTerrainFragmentShader;

export type CbtTerrainMaterialOptions = {
    /** Planet radius (sim units) — must match the radius used by the emitter. */
    radius: number;
    /** Noise field — must match the field used for CPU displacement (DEFAULT_NOISE). */
    noise?: NoiseParams;
    albedo?: Vector3;
    ambient?: Vector3;
    lightColor?: Vector3;
    lightIntensity?: number;
};

/**
 * Build the per-pixel-normal CBT terrain {@link ShaderMaterial}. The fragment
 * shader recomputes the surface normal from the noise gradient per pixel, so
 * shading no longer pops when triangles refine. The noise field (params + the
 * seeded permutation table) is uploaded so the GPU normal matches the CPU
 * radial displacement exactly.
 */
export function createCbtTerrainMaterial(
    scene: Scene,
    key: string,
    opts: CbtTerrainMaterialOptions
): ShaderMaterial {
    const noise = opts.noise ?? DEFAULT_NOISE;

    const mat = new ShaderMaterial(
        `cbt_terrain_${key}`,
        scene,
        { vertex: 'cbtTerrain', fragment: 'cbtTerrain' },
        {
            attributes: ['position', 'uv', 'color'],
            uniforms: [
                'world',
                'worldViewProjection',
                'uRadius',
                'uLightDirection',
                'uLightColor',
                'uLightIntensity',
                'uAlbedo',
                'uAmbient',
                'uDebugLod',
                'uPerm',
                'uOctaves',
                'uBaseFrequency',
                'uBaseAmplitude',
                'uLacunarity',
                'uPersistence',
                'uGlobalAmplitude',
                'logarithmicDepthConstant'
            ],
            // Logarithmic depth so the planet stays visible across the full 1:1
            // depth range (matches the previous StandardMaterial setting).
            defines: ['#define LOGARITHMICDEPTH']
        }
    );

    // logarithmicDepthConstant is not auto-bound for a ShaderMaterial; refresh it
    // each bind from the active camera's far plane.
    mat.onBindObservable.add(() => {
        const camera = scene.activeCamera;
        const maxZ = camera && camera.maxZ > 0 ? camera.maxZ : 1e9;
        mat.setFloat('logarithmicDepthConstant', 2.0 / (Math.log2(maxZ + 1.0)));
    });

    // Upload the exact seeded permutation table (0..255) so the GPU noise field
    // is the same as the CPU one used for displacement.
    const perm = buildPerm(noise.seed);
    const permFloats = new Array<number>(256);
    for (let i = 0; i < 256; i++) permFloats[i] = perm[i];
    mat.setFloats('uPerm', permFloats);

    mat.setInt('uOctaves', noise.octaves);
    mat.setFloat('uBaseFrequency', noise.baseFrequency);
    mat.setFloat('uBaseAmplitude', noise.baseAmplitude);
    mat.setFloat('uLacunarity', noise.lacunarity);
    mat.setFloat('uPersistence', noise.persistence);
    mat.setFloat('uGlobalAmplitude', noise.globalAmplitude);

    mat.setFloat('uRadius', opts.radius);
    mat.setVector3('uLightDirection', new Vector3(0, -1, 0)); // updated per frame
    mat.setVector3('uLightColor', opts.lightColor ?? new Vector3(1, 1, 1));
    mat.setFloat('uLightIntensity', opts.lightIntensity ?? 1.5);
    mat.setVector3('uAlbedo', opts.albedo ?? new Vector3(0.6, 0.55, 0.4));
    mat.setVector3('uAmbient', opts.ambient ?? new Vector3(0.03, 0.03, 0.03));
    mat.setInt('uDebugLod', 0);

    mat.backFaceCulling = true;
    return mat;
}
