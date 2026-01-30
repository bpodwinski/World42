import { Vector3 } from "@babylonjs/core";

/**
 * Conservative "backside" culling for a spherical planet.
 * Returns true when the patch can be visible (front hemisphere),
 * false when it is guaranteed on the far side.
 *
 * This is not terrain self-occlusion (mountains), only planet body occlusion.
 */
export function backsideCulling(
    camPos: Vector3,
    planetCenter: Vector3,
    patchCenter: Vector3,
    patchBoundingRadius: number
): boolean {
    const observerDir = camPos.subtract(planetCenter);
    const odLen = observerDir.length();
    if (odLen <= 1e-6) return true;
    observerDir.scaleInPlace(1 / odLen);

    // Direction from patch center towards camera
    const toCam = camPos.subtract(patchCenter);
    const tcLen = toCam.length();
    if (tcLen <= 1e-6) return true;
    toCam.scaleInPlace(1 / tcLen);

    // Closest point on the patch bounding sphere towards the camera
    const closestPoint = patchCenter.add(toCam.scale(patchBoundingRadius));

    // "Conservative" normal from planet center to that closest point
    const n = closestPoint.subtract(planetCenter);
    const nLen = n.length();
    if (nLen <= 1e-6) return true;
    n.scaleInPlace(1 / nLen);

    return Vector3.Dot(observerDir, n) >= 0;
}
