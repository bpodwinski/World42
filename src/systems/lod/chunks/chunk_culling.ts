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
 * camPos / planetCenter / chunkCenter are in world(sim) space (doublepos space).
 *
 * Returns true if chunk is potentially visible above the horizon.
 *
 * Source: https://cesium.com/blog/2013/04/25/horizon-culling/
 */
export function horizonCulling(
    camPos: Vector3,
    planetCenter: Vector3,
    planetRadius: number,
    chunkCenter: Vector3,
    chunkBoundingRadius: number
): boolean {
    const VC = camPos.subtract(planetCenter);
    const d = VC.length();

    // Camera inside planet
    if (d <= planetRadius) return false;

    const dirCam = VC.scale(1 / d);

    const CC = chunkCenter.subtract(planetCenter);
    const ccLen = CC.length() || 1;
    const dirChunk = CC.scale(1 / ccLen);

    // Horizon half-angle alpha
    const cosAlpha = planetRadius / d; // (0..1)
    const alpha = Math.acos(Math.min(1, Math.max(0, cosAlpha)));

    // Chunk angular radius beta (conservative)
    const s = chunkBoundingRadius / planetRadius;
    const beta = Math.asin(Math.min(1, Math.max(0, s)));

    // Angle between camera direction and chunk direction
    const dot = Vector3.Dot(dirCam, dirChunk);
    const angle = Math.acos(Math.min(1, Math.max(-1, dot)));

    return angle <= alpha + beta;
}
