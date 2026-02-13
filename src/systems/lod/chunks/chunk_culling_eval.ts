import type { Plane, Vector3 } from "@babylonjs/core";
import { isSphereInFrustum } from "./chunk_metrics";
import { backsideCulling } from "./backside_culling";
import type { OriginCamera } from "../../../core/camera/camera_manager";

/**
 * Result of the culling evaluation combining strict visibility and prefetch guard-bands.
 */
export type CullResult = {
    /** True if the patch should be drawn this frame (strict tests). */
    drawStrict: boolean;

    /** True if the patch is inside the prefetch guard-band (may request mesh, but not necessarily draw). */
    inPrefetch: boolean;

    /** True if the patch bounding sphere passes the strict frustum test. */
    frustumStrict: boolean;

    /** True if the patch bounding sphere passes the prefetch frustum test (guard-band). */
    frustumPrefetch: boolean;

    /** True if the patch passes the strict horizon/backside test (front side). */
    horizonStrict: boolean;

    /** True if the patch passes the prefetch horizon/backside test (guard-band). */
    horizonPrefetch: boolean;
};

/**
 * Evaluate frustum + horizon/backside culling using strict tests and prefetch guard-bands.
 *
 * Coordinate spaces:
 * - `camWorldDouble`, `planetCenterWorldDouble`, and `centerWorldDouble` must be in the same space
 *   (WorldDouble in this project).
 * - Frustum test is performed in Render-space by converting:
 *   `centerRender = centerWorldDouble - camWorldDouble`.
 *
 * Behavior:
 * - If the patch is outside the prefetch guard-band for frustum or horizon, it is guaranteed invisible
 *   and can be fully ignored (`inPrefetch = false`).
 * - If the patch is inside the prefetch band but fails strict tests, it can be prefetched (mesh request)
 *   while staying hidden (`drawStrict = false`).
 *
 * @param args Culling inputs and scratch buffers.
 * @returns Combined culling result with strict and prefetch flags.
 */
export function evalChunkCulling(args: {
    camera: OriginCamera;
    frustumPlanes: Plane[];
    camWorldDouble: Vector3;

    planetCenterWorldDouble: Vector3;
    centerWorldDouble: Vector3;
    radiusForCull: number;

    frustumEnabled: boolean;
    backsideEnabled: boolean;

    frustumPrefetchScale: number;
    horizonPrefetchScale: number;

    /** Scratch vector for `centerRender` conversion (WorldDouble -> Render-space). */
    centerRenderTmp: Vector3;
}): CullResult {
    const {
        frustumEnabled,
        backsideEnabled,
        frustumPlanes,
        camWorldDouble,
        centerWorldDouble,
        radiusForCull,
        planetCenterWorldDouble,
        frustumPrefetchScale,
        horizonPrefetchScale,
        centerRenderTmp,
    } = args;

    let frS = true;
    let frP = true;

    if (frustumEnabled) {
        // WorldDouble -> Render-space (floating origin)
        centerWorldDouble.subtractToRef(camWorldDouble, centerRenderTmp);

        frS = isSphereInFrustum(centerRenderTmp, radiusForCull, frustumPlanes);
        frP = frS || isSphereInFrustum(centerRenderTmp, radiusForCull * frustumPrefetchScale, frustumPlanes);

        // Outside the prefetch band => guaranteed invisible.
        if (!frP) {
            return {
                drawStrict: false,
                inPrefetch: false,
                frustumStrict: frS,
                frustumPrefetch: frP,
                horizonStrict: true,
                horizonPrefetch: true,
            };
        }
    }

    let hoS = true;
    let hoP = true;

    if (backsideEnabled) {
        hoS = backsideCulling(camWorldDouble, planetCenterWorldDouble, centerWorldDouble, radiusForCull);
        hoP =
            hoS ||
            backsideCulling(
                camWorldDouble,
                planetCenterWorldDouble,
                centerWorldDouble,
                radiusForCull * horizonPrefetchScale
            );

        // Outside the prefetch band => guaranteed invisible.
        if (!hoP) {
            return {
                drawStrict: false,
                inPrefetch: false,
                frustumStrict: frS,
                frustumPrefetch: frP,
                horizonStrict: hoS,
                horizonPrefetch: hoP,
            };
        }
    }

    const drawStrict = (!frustumEnabled || frS) && (!backsideEnabled || hoS);
    const inPrefetch = (!frustumEnabled || frP) && (!backsideEnabled || hoP);

    return {
        drawStrict,
        inPrefetch,
        frustumStrict: frS,
        frustumPrefetch: frP,
        horizonStrict: hoS,
        horizonPrefetch: hoP,
    };
}
