import { Vector3 } from "@babylonjs/core";

/**
 * Horizon culling using an *angular* patch footprint.
 *
 * @param patchAngularRadius Angular radius (radians) of the patch footprint on the base sphere.
 *                           This must be independent from terrain amplitude (computed from UV corners).
 */
export function horizonCulling(
    camPos: Vector3,
    planetCenter: Vector3,
    planetRadius: number,
    patchCenter: Vector3,
    patchAngularRadius: number
): boolean {
    const VC = camPos.subtract(planetCenter);
    const d = VC.length();

    // Camera inside/on planet -> no horizon culling
    if (d <= planetRadius) return true;

    const dirCam = VC.scale(1 / d);

    const PC = patchCenter.subtract(planetCenter);
    const pcLen = PC.length();
    if (pcLen <= 1e-9) return true;

    const dirPatch = PC.scale(1 / pcLen);

    // Horizon half-angle to the limb
    const cosAlpha = planetRadius / d; // (0..1)
    const alpha = Math.acos(Math.min(1, Math.max(0, cosAlpha)));

    // Angle between camera direction and patch direction
    const dot = Vector3.Dot(dirCam, dirPatch);
    const angle = Math.acos(Math.min(1, Math.max(-1, dot)));

    // Patch is visible if its cone intersects the visible cap
    return angle <= alpha + patchAngularRadius;
}
