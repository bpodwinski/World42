import { Plane, Vector3 } from "@babylonjs/core";

/**
 * Sphere vs frustum planes test (in render-space).
 * Returns false if sphere is completely outside any plane.
 */
export function isSphereInFrustum(
    centerRender: Vector3,
    radius: number,
    planes: Plane[]
): boolean {
    for (const p of planes) {
        // outside if n·p + d < -radius
        if (
            p.normal.x * centerRender.x +
            p.normal.y * centerRender.y +
            p.normal.z * centerRender.z +
            p.d <
            -radius
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Horizon culling on a planet.
 * camPos / planetCenter / patchCenter are in world(sim) space (doublepos space).
 *
 * Returns true if patch is potentially visible above the horizon.
 * 
 * Source: https://cesium.com/blog/2013/04/25/horizon-culling/
 */
export function horizonCulling(
    camPos: Vector3,
    planetCenter: Vector3,
    planetRadius: number,
    patchCenter: Vector3,
    patchBoundingRadius: number
): boolean {
    const VC = camPos.subtract(planetCenter);
    const d = VC.length();

    // Camera inside/on planet: disable horizon culling
    if (d <= planetRadius) return true;

    const dirCam = VC.scale(1 / d);

    const PC = patchCenter.subtract(planetCenter);
    const pcLen = PC.length() || 1;
    const dirPatch = PC.scale(1 / pcLen);

    // Horizon half-angle alpha
    const cosAlpha = planetRadius / d; // (0..1)
    const alpha = Math.acos(Math.min(1, Math.max(0, cosAlpha)));

    // Patch angular radius beta (conservative)
    const s = patchBoundingRadius / planetRadius;
    const beta = Math.asin(Math.min(1, Math.max(0, s)));

    // Angle between camera direction and patch direction
    const dot = Vector3.Dot(dirCam, dirPatch);
    const angle = Math.acos(Math.min(1, Math.max(-1, dot)));

    return angle <= alpha + beta;
}
