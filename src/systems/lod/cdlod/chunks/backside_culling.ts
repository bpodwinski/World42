import { Vector3 } from "@babylonjs/core";

/**
 * Conservative backside/horizon culling for a spherical planet.
 *
 * This test answers: "Can this patch be visible from the camera position
 * given occlusion by the planet body?"
 *
 * It does NOT handle terrain self-occlusion (mountains), only occlusion
 * by the sphere itself.
 *
 * Coordinate space:
 * - `camPos`, `planetCenter`, and `patchCenter` must be in the same space
 *   (typically WorldDouble in this project).
 *
 * @param camPos Camera position.
 * @param planetCenter Planet center position.
 * @param patchCenter Patch center position.
 * @param patchBoundingRadius Bounding sphere radius for the patch (in the same units as positions).
 * @returns `true` if the patch may be visible (front side), `false` if guaranteed to be occluded (back side).
 */
export function backsideCulling(
    camPos: Vector3,
    planetCenter: Vector3,
    patchCenter: Vector3,
    patchBoundingRadius: number
): boolean {
    // Observer direction from planet center to camera.
    const observerDir = camPos.subtract(planetCenter);
    const odLen = observerDir.length();
    if (odLen <= 1e-6) return true;
    observerDir.scaleInPlace(1 / odLen);

    // Direction from patch center to camera.
    const toCam = camPos.subtract(patchCenter);
    const tcLen = toCam.length();
    if (tcLen <= 1e-6) return true;
    toCam.scaleInPlace(1 / tcLen);

    // Conservative point on the patch bounding sphere closest to the camera.
    const closestPoint = patchCenter.add(toCam.scale(patchBoundingRadius));

    // Approximate outward normal from planet center at that closest point.
    const n = closestPoint.subtract(planetCenter);
    const nLen = n.length();
    if (nLen <= 1e-6) return true;
    n.scaleInPlace(1 / nLen);

    // Visible if the patch normal faces the camera hemisphere.
    return Vector3.Dot(observerDir, n) >= 0;
}
