import type { Scene, Plane } from "@babylonjs/core";
import { Vector3 } from "@babylonjs/core";

/**
 * Estimates patch world size from its 4 corner positions.
 * Uses the maximum edge/diagonal length as a conservative proxy for patch diameter.
 */
export function estimatePatchWorldSize(corners: Vector3[]): number {
    let max2 = 0;

    const pairs: [number, number][] = [
        [0, 1], [0, 2], [1, 3], [2, 3], // edges
        [0, 3], [1, 2],                 // diagonals
    ];

    for (const [a, b] of pairs) {
        const dx = corners[b].x - corners[a].x;
        const dy = corners[b].y - corners[a].y;
        const dz = corners[b].z - corners[a].z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > max2) max2 = d2;
    }

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
    corners: Vector3[]
): { distance: number; radius: number } {
    let r2 = 0;
    for (const c of corners) {
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
 * Computes Screen-Space Error (SSE) in pixels.
 *
 * SSE_px ≈ (geometricError / distanceToPatch) * K
 * where K = viewportHeight / (2 * tan(fov/2))
 *
 * geometricError is approximated from patch size and mesh resolution.
 */
export function computeSSEPx(args: {
    scene: Scene;
    cameraFov: number;
    distanceToPatch: number;
    corners: Vector3[];
    resolution: number;
    geomErrorScale: number;
    minDistEpsilon: number;
}): number {
    const {
        scene,
        cameraFov,
        distanceToPatch,
        corners,
        resolution,
        geomErrorScale,
        minDistEpsilon,
    } = args;

    const engine = scene.getEngine();
    const viewportH = engine.getRenderHeight(true);

    // Projection factor (pixels per world-unit at distance 1)
    const K = viewportH / (2 * Math.tan(cameraFov * 0.5));

    // Approximate geometric error: patch diameter / grid resolution (scaled empirically)
    const patchSize = estimatePatchWorldSize(corners);
    const geometricError = (patchSize / resolution) * geomErrorScale;

    const d = Math.max(distanceToPatch, minDistEpsilon);
    return (geometricError / d) * K;
}

/**
 * Frustum test for a bounding sphere in render space.
 * A point is outside if for any plane: n·p + d < -radius
 */
export function isSphereInFrustum(
    centerRender: Vector3,
    radius: number,
    planes: Plane[]
): boolean {
    for (const p of planes) {
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