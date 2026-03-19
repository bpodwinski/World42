import type { Plane, Scene } from "@babylonjs/core";
import { Vector3 } from "@babylonjs/core";

/** K = viewportHeight / (2 * tan(fov/2)) */
export function computeSSEFactor(scene: Scene, cameraFov: number): number {
    const viewportH = scene.getEngine().getRenderHeight(true);
    return viewportH / (2 * Math.tan(cameraFov * 0.5));
}

/**
 * Estimates patch world size from its 4 corner positions.
 * Uses the maximum edge/diagonal length as a conservative proxy for patch diameter.
 */
export function estimatePatchWorldSize4(corners: readonly Vector3[]): number {
    const c0 = corners[0], c1 = corners[1], c2 = corners[2], c3 = corners[3];

    const d01 = Vector3.DistanceSquared(c0, c1);
    const d02 = Vector3.DistanceSquared(c0, c2);
    const d13 = Vector3.DistanceSquared(c1, c3);
    const d23 = Vector3.DistanceSquared(c2, c3);
    const d03 = Vector3.DistanceSquared(c0, c3);
    const d12 = Vector3.DistanceSquared(c1, c2);

    const max2 = Math.max(d01, d02, d13, d23, d03, d12);
    return Math.sqrt(max2);
}

/**
 * Computes camera-to-patch distance using a bounding sphere.
 *
 * distance = max(0, distance(camera, sphereCenter) - sphereRadius)
 *
 * - sphereCenter: patch center
 * - sphereRadius: max distance from center to corners (conservative)
 */
export function distanceToPatchBoundingSphere(
    camPos: Vector3,
    patchCenter: Vector3,
    corners: readonly Vector3[]
): { distance: number; radius: number } {
    let r2 = 0;
    for (let i = 0; i < corners.length; i++) {
        const c = corners[i];
        const dx = c.x - patchCenter.x;
        const dy = c.y - patchCenter.y;
        const dz = c.z - patchCenter.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) r2 = d2;
    }
    const sphereRadius = Math.sqrt(r2);

    const dc = Vector3.Distance(camPos, patchCenter);
    const distance = Math.max(0, dc - sphereRadius);

    return { distance, radius: sphereRadius };
}

/**
 * SSE in pixels using a precomputed K factor.
 *
 * SSE_px ≈ (geometricError / distanceToPatch) * K
 * geometricError ≈ (patchSize / resolution) * geomErrorScale
 */
export function computeSSEPxFast(args: {
    patchSize: number;
    resolution: number;
    geomErrorScale: number;
    distanceToPatch: number;
    minDistEpsilon: number;
    sseK: number;
}): number {
    const geometricError = (args.patchSize / args.resolution) * args.geomErrorScale;
    const d = Math.max(args.distanceToPatch, args.minDistEpsilon);
    return (geometricError / d) * args.sseK;
}

/**
 * Frustum test for a bounding sphere in render space.
 * A point is outside if for any plane: n·p + d < -radius
 */
export function isSphereInFrustum(centerRender: Vector3, radius: number, planes: Plane[]): boolean {
    for (const p of planes) {
        if (p.normal.x * centerRender.x + p.normal.y * centerRender.y + p.normal.z * centerRender.z + p.d < -radius) {
            return false;
        }
    }
    return true;
}
