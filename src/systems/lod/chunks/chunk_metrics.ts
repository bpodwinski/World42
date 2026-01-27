import { Vector3 } from "@babylonjs/core";

/**
 * Max edge/diagonal length of a quad patch (4 corners) as conservative "diameter".
 * corners order is free, but expected 4 points.
 */
export function estimatePatchWorldSize(corners: Vector3[]): number {
    let max2 = 0;

    // edges + diagonals (assuming corners are [00, 01, 10, 11] or similar)
    const pairs: [number, number][] = [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3], // edges
        [0, 3],
        [1, 2], // diagonals
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
 * Camera-to-patch distance using a bounding sphere computed from corners around patchCenter.
 *
 * distance = max(0, distance(camPos, patchCenter) - sphereRadius)
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
 * Screen-Space Error (SSE) in pixels.
 *
 * SSE_px ≈ (geometricError / distanceToPatch) * K
 * where K = viewportHeight / (2 * tan(fov/2))
 *
 * - patchSize: estimated via corners
 * - geometricError: (patchSize / resolution) * geomErrorScale
 */
export function computeSSEPx(args: {
    fov: number;              // radians
    viewportH: number;        // pixels (engine.getRenderHeight(true))
    distanceToPatch: number;  // world units
    corners: Vector3[];       // 4 corner points (world/local ok as long as consistent)
    resolution: number;
    geomErrorScale: number;
    minDistEpsilon?: number;
}): number {
    const {
        fov,
        viewportH,
        distanceToPatch,
        corners,
        resolution,
        geomErrorScale,
        minDistEpsilon = 1e-3,
    } = args;

    const K = viewportH / (2 * Math.tan(fov * 0.5));
    const patchSize = estimatePatchWorldSize(corners);
    const geometricError = (patchSize / resolution) * geomErrorScale;

    const d = Math.max(distanceToPatch, minDistEpsilon);
    return (geometricError / d) * K;
}
