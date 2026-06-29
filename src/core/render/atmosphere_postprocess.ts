import { Matrix, Vector3, type Scene } from '@babylonjs/core';
import type { OriginCamera } from '../camera/camera_manager';
import type { ResolvedAtmosphere } from '../../game_world/stellar_system/planet_lighting';
import atmosphereFragmentShader from '../../assets/shaders/atmosphere/atmosphereFragmentShader.wgsl';

/** A planet that has an atmosphere, with everything the ray-march pass needs. */
export type AtmosphereSource = {
    /** Planet centre in WorldDouble (live reference to the FloatingEntity doublepos). */
    centerWorldDouble: Vector3;
    /** Surface radius in km (= radiusSim, 1 sim = 1 km). */
    radiusKm: number;
    /** Nearest star position in WorldDouble (sun direction), or null. */
    starPosWorldDouble: Vector3 | null;
    /** Resolved physical atmosphere parameters. */
    params: ResolvedAtmosphere;
};

/** Uniform names the atmosphere effect needs (shared by the Frame Graph task). */
export const ATMO_PP_UNIFORMS = [
    'inverseProjection',
    'inverseView',
    'cameraPositionRender',
    'planetCenterRender',
    'planetRadiusKm',
    'atmoTopKm',
    'sunDirRender',
    'sunIntensity',
    'betaR',
    'betaM',
    'rayleighScaleKm',
    'mieScaleKm',
    'mieG',
] as const;

/** No extra samplers: the surface is bounded analytically, so the pass never samples scene depth. */
export const ATMO_PP_SAMPLERS = [] as const;

/** Raw GLSL fragment source for the Frame Graph custom task. */
export const ATMO_PP_FRAGMENT = atmosphereFragmentShader;

/** Pick the atmosphere whose planet centre is nearest the camera (v1 supports one active at a time). */
export function pickNearestAtmosphere(
    camWorldDouble: Vector3,
    sources: AtmosphereSource[]
): AtmosphereSource | null {
    if (!sources.length) return null;
    let best = sources[0];
    let bestD2 = Vector3.DistanceSquared(camWorldDouble, best.centerWorldDouble);
    for (let i = 1; i < sources.length; i++) {
        const d2 = Vector3.DistanceSquared(camWorldDouble, sources[i].centerWorldDouble);
        if (d2 < bestD2) {
            best = sources[i];
            bestD2 = d2;
        }
    }
    return best;
}

const _invProj = new Matrix();
const _invView = new Matrix();
const _centerRender = new Vector3();
const _starRender = new Vector3();
const _sunDir = new Vector3();

/**
 * Sets every uniform of the atmosphere effect for the current frame from the nearest atmosphere
 * source. Does NOT bind `depthSampler` (the Frame Graph task binds the graph depth handle). When no
 * source is active it sets `sunIntensity = 0`, which makes the shader pass the scene through untouched.
 * Allocation-free.
 */
export function setAtmosphereUniforms(
    effect: {
        setFloat: (n: string, v: number) => void;
        setVector3: (n: string, v: Vector3) => void;
        setMatrix: (n: string, v: Matrix) => void;
    },
    _scene: Scene,
    camera: OriginCamera,
    sources: AtmosphereSource[]
): void {
    camera.getProjectionMatrix().invertToRef(_invProj);
    camera.getViewMatrix().invertToRef(_invView);
    effect.setMatrix('inverseProjection', _invProj);
    effect.setMatrix('inverseView', _invView);
    effect.setVector3('cameraPositionRender', camera.position);

    const src = pickNearestAtmosphere(camera.doublepos, sources);
    if (!src) {
        effect.setFloat('sunIntensity', 0.0);
        effect.setVector3('planetCenterRender', Vector3.ZeroReadOnly as unknown as Vector3);
        effect.setFloat('planetRadiusKm', 1.0);
        effect.setFloat('atmoTopKm', 1.0);
        effect.setVector3('sunDirRender', Vector3.UpReadOnly as unknown as Vector3);
        effect.setVector3('betaR', Vector3.ZeroReadOnly as unknown as Vector3);
        effect.setFloat('betaM', 0.0);
        effect.setFloat('rayleighScaleKm', 1.0);
        effect.setFloat('mieScaleKm', 1.0);
        effect.setFloat('mieG', 0.0);
        return;
    }

    camera.toRenderSpace(src.centerWorldDouble, _centerRender);
    effect.setVector3('planetCenterRender', _centerRender);
    effect.setFloat('planetRadiusKm', src.radiusKm);
    effect.setFloat('atmoTopKm', src.radiusKm + src.params.heightKm);

    if (src.starPosWorldDouble) {
        camera.toRenderSpace(src.starPosWorldDouble, _starRender);
        _starRender.subtractToRef(_centerRender, _sunDir);
        if (_sunDir.lengthSquared() > 1e-12) _sunDir.normalize();
        else _sunDir.set(0, 1, 0);
    } else {
        _sunDir.set(0, 1, 0);
    }
    effect.setVector3('sunDirRender', _sunDir);
    effect.setFloat('sunIntensity', src.params.intensity);

    const r = src.params.rayleigh;
    _starRender.set(r[0], r[1], r[2]); // reuse temp as betaR carrier
    effect.setVector3('betaR', _starRender);
    effect.setFloat('betaM', src.params.mie);
    effect.setFloat('rayleighScaleKm', src.params.rayleighScaleKm);
    effect.setFloat('mieScaleKm', src.params.mieScaleKm);
    effect.setFloat('mieG', src.params.mieG);
}
