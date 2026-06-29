import { Scene, TAARenderingPipeline } from '@babylonjs/core';
import type { OriginCamera } from '../camera/camera_manager';

/**
 * Temporal Anti-Aliasing.
 *
 * Fixes the residual grain seen on the airless terrain at grazing sun angles
 * (sub-pixel geometric + shading-normal aliasing that FXAA and the in-shader
 * normal-variance / specular AA cannot fully remove).
 *
 * IMPORTANT ordering constraint (Babylon docs): the TAA pipeline MUST be created
 * BEFORE any other post-process / DefaultRenderingPipeline on the same camera —
 * "TAA post-process must be the first in the camera". Creating it afterwards is
 * what white-screened this custom pipeline (log depth + WGSL TERRAIN material + star
 * post-process) on the first attempt. Call this helper before `new PostProcess(...)`.
 *
 * `reprojectHistory` is left OFF: reprojection requires the Babylon PrePass
 * renderer (velocity buffer) which is incompatible with the TERRAIN GPU-driven
 * implicit mesh + manual logarithmic depth. Without it, TAA jitters and
 * accumulates while the view is still and disables itself on camera move
 * (`disableOnCameraMove`), so there is no ghosting/smear — exactly the static
 * grazing case we need to fix. The jitter is injected into the camera projection
 * matrix and propagates to the TERRAIN material automatically through
 * `camera.viewProjection`, so no terrain-shader change is required.
 */
export function attachTaaPipeline(scene: Scene, camera: OriginCamera): TAARenderingPipeline | null {
    const taa = new TAARenderingPipeline('taa', scene, [camera]);
    if (!taa.isSupported) {
        taa.dispose();
        return null;
    }
    taa.samples = 16; // accumulate up to 16 jittered frames while still
    taa.disableOnCameraMove = true; // no reprojection -> avoid smear when moving
    taa.clampHistory = true; // 3x3 neighborhood clamp -> kills ghosting/fireflies
    taa.reprojectHistory = false; // no PrePass/velocity (incompatible here)
    return taa;
}
