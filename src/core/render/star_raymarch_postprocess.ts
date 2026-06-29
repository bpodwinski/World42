import { Matrix, Vector3, Scene } from "@babylonjs/core";
import type { OriginCamera } from "../camera/camera_manager";
import starRayMarchingFragmentShader from "../../assets/shaders/stars/starRayMarchingFragmentShader.wgsl";

export type StarGlowSource = {
    posWorldDouble: Vector3;
    radius: number;
    color: Vector3;
    intensity: number;
};

export type StarOccluder = {
    posWorldDouble: Vector3;
    radiusSim: number;
};

/** Uniform names the star ray-march effect needs (shared by the legacy PostProcess and the Frame Graph task). */
export const STAR_PP_UNIFORMS = [
    "time",
    "cameraPositionRender",
    "starCenterRender",
    "starRadius",
    "tMax",
    "starColor",
    "starIntensity",
    "occluderCenter",
    "occluderRadius",
    "inverseProjection",
    "inverseView",
    "logarithmicDepthConstant",
    "cameraNear",
    "cameraFar",
] as const;

/** Sampler names (besides the implicit `textureSampler` scene-color input). */
export const STAR_PP_SAMPLERS = ["depthSampler"] as const;

/** The raw GLSL fragment source for reuse by the Frame Graph custom task. */
export const STAR_PP_FRAGMENT = starRayMarchingFragmentShader;

// Reused allocations for the per-frame uniform computation (shared helper).
const _starCenterRender = new Vector3();
const _occluderCenterRender = new Vector3();
const _invProj = new Matrix();
const _invView = new Matrix();

/**
 * Sets every scalar/vector/matrix uniform of the star ray-march effect for the current frame.
 * Does NOT bind `depthSampler` (the depth source differs: legacy uses a DepthRenderer map,
 * the Frame Graph task binds a graph texture handle). Allocation-free.
 */
export function setStarUniforms(
    effect: { setFloat: (n: string, v: number) => void; setVector3: (n: string, v: Vector3) => void; setMatrix: (n: string, v: Matrix) => void },
    _scene: Scene,
    camera: OriginCamera,
    stars: StarGlowSource[],
    occluders: StarOccluder[] | undefined
): void {
    effect.setFloat("time", performance.now() * 0.001);

    camera.getProjectionMatrix().invertToRef(_invProj);
    camera.getViewMatrix().invertToRef(_invView);
    effect.setMatrix("inverseProjection", _invProj);
    effect.setMatrix("inverseView", _invView);

    effect.setVector3("cameraPositionRender", camera.position);

    const star = pickNearestStar(camera.doublepos, stars);
    if (star) {
        camera.toRenderSpace(star.posWorldDouble, _starCenterRender);
        effect.setVector3("starCenterRender", _starCenterRender);
        effect.setFloat("starRadius", star.radius);
        const dist = _starCenterRender.length();
        effect.setFloat("tMax", dist + star.radius * 2.0 + 1000.0);
        effect.setVector3("starColor", star.color);
        effect.setFloat("starIntensity", star.intensity);
    } else {
        _starCenterRender.set(1e12, 1e12, 1e12);
        effect.setVector3("starCenterRender", _starCenterRender);
        effect.setFloat("starRadius", 1.0);
        effect.setFloat("tMax", 1.0);
        effect.setVector3("starColor", Vector3.OneReadOnly as unknown as Vector3);
        effect.setFloat("starIntensity", 0.0);
    }

    let nearestOccluder: StarOccluder | null = null;
    if (occluders && occluders.length > 0) {
        let bestD2 = Infinity;
        for (const occ of occluders) {
            const d2 = Vector3.DistanceSquared(camera.doublepos, occ.posWorldDouble);
            if (d2 < bestD2) {
                bestD2 = d2;
                nearestOccluder = occ;
            }
        }
    }
    if (nearestOccluder) {
        camera.toRenderSpace(nearestOccluder.posWorldDouble, _occluderCenterRender);
        effect.setVector3("occluderCenter", _occluderCenterRender);
        effect.setFloat("occluderRadius", nearestOccluder.radiusSim);
    } else {
        effect.setVector3("occluderCenter", Vector3.ZeroReadOnly as unknown as Vector3);
        effect.setFloat("occluderRadius", -1.0);
    }

    const maxZ = camera.maxZ > 0 ? camera.maxZ : 1e9;
    effect.setFloat("logarithmicDepthConstant", 2.0 / Math.log2(maxZ + 1.0));
    effect.setFloat("cameraNear", camera.minZ);
    effect.setFloat("cameraFar", maxZ);
}

function pickNearestStar(camWorldDouble: Vector3, stars: StarGlowSource[]): StarGlowSource | null {
    if (!stars.length) return null;
    let best = stars[0];
    let bestD2 = Vector3.DistanceSquared(camWorldDouble, best.posWorldDouble);
    for (let i = 1; i < stars.length; i++) {
        const s = stars[i];
        const d2 = Vector3.DistanceSquared(camWorldDouble, s.posWorldDouble);
        if (d2 < bestD2) {
            best = s;
            bestD2 = d2;
        }
    }
    return best;
}
