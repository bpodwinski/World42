import { Vector3 } from "@babylonjs/core";

/**
 * Conservative horizon culling test.
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

    // If camera is inside / on the planet, disable horizon culling
    if (d <= planetRadius) return true;

    const dirCam = VC.scale(1 / d);

    const PC = patchCenter.subtract(planetCenter);
    const pcLen = PC.length() || 1;
    const dirPatch = PC.scale(1 / pcLen);

    // Horizon angle
    const cosAlpha = planetRadius / d; // in (0..1)
    const alpha = Math.acos(Math.min(1, Math.max(0, cosAlpha)));

    // Patch angular radius (conservative)
    const s = patchBoundingRadius / pcLen;
    const beta = Math.asin(Math.min(1, Math.max(0, s)));

    // Angle between camera direction and patch direction
    const dot = Vector3.Dot(dirCam, dirPatch);
    const angle = Math.acos(Math.min(1, Math.max(-1, dot)));

    return angle <= alpha + beta;
}