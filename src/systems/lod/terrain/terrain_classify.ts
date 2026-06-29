import { Matrix, Plane, Vector3 } from '@babylonjs/core';
import type { CbtNode } from './cbt_state';

export type CbtSplitCandidate = {
    nodeId: number;
    score: number;
    projectedAreaPx2: number;
};

export type CbtLeafMetric = {
    nodeId: number;
    parentId: number | null;
    projectedAreaPx2: number;
};

export type CbtClassifyParams = {
    leaves: ReadonlyArray<CbtNode>;
    cameraWorldDouble: Vector3;
    planetCenterWorldDouble: Vector3;
    renderParentWorldMatrix: Matrix;
    viewportHeightPx: number;
    cameraFovRadians: number;
    splitThresholdPx2: number;
    splitHysteresis: number;
    /**
     * When true, leaves on the planet's far hemisphere are excluded from split
     * candidates (paper-style backside cull). Merges are still allowed for
     * culled leaves so detail is reclaimed off-screen. Default false.
     */
    cullBackface?: boolean;
    /**
     * Guard band for the backside cull, as a cosine threshold on
     * dot(surfaceNormal, dirToCamera). 0 = exact horizon plane; a small negative
     * value (default -0.05) keeps a thin band just behind the horizon to avoid
     * silhouette pop when rotating. Only used when {@link cullBackface} is true.
     */
    cullMinDot?: number;
    /**
     * Render-space camera frustum planes (from `Frustum.GetPlanes`). When set,
     * leaves whose bounding sphere is fully outside the frustum (beyond the guard
     * band) are excluded from split candidates — off-screen geometry stops
     * refining. Merges still see every leaf, so off-screen detail collapses.
     */
    frustumPlanes?: ReadonlyArray<Plane> | null;
    /**
     * Frustum guard band as a multiple of each triangle's bounding radius. The
     * effective cull margin is `boundRadius * (1 + guard)`, so a band around the
     * view keeps refining (prefetch) to avoid pop when the camera turns. Default 1.
     */
    frustumGuardScale?: number;
};

const MIN_DISTANCE = 1.0;
const DEFAULT_CULL_MIN_DOT = -0.05;
const DEFAULT_FRUSTUM_GUARD = 1.0;

/**
 * Is a triangle's bounding sphere fully outside the frustum (beyond the margin)?
 * `r*` is the sphere centre in render space; planes have inward normals.
 */
function outsideFrustum(
    rx: number, ry: number, rz: number,
    boundRadius: number,
    planes: ReadonlyArray<Plane>,
    guardScale: number
): boolean {
    const margin = boundRadius * (1 + guardScale);
    for (let i = 0; i < planes.length; i++) {
        const pl = planes[i];
        const d = pl.normal.x * rx + pl.normal.y * ry + pl.normal.z * rz + pl.d;
        if (d < -margin) return true; // fully on the outside of this plane
    }
    return false;
}

/**
 * Backside test for a leaf centroid. `r*` is the outward surface normal
 * (centroid − planetCenter); `t*` is the direction to the camera
 * (camera − centroid). Returns true when the leaf faces away from the camera
 * beyond the guard band. One sqrt; no allocation.
 */
function isBackface(
    rx: number, ry: number, rz: number,
    tx: number, ty: number, tz: number,
    minDot: number
): boolean {
    const dot = rx * tx + ry * ty + rz * tz;
    if (minDot === 0) return dot <= 0;
    const rl2 = rx * rx + ry * ry + rz * rz;
    const tl2 = tx * tx + ty * ty + tz * tz;
    if (rl2 < 1e-24 || tl2 < 1e-24) return false;
    return dot < minDot * Math.sqrt(rl2 * tl2);
}

/**
 * Is a single vertex behind the camera's horizon? `v` is the leaf vertex in
 * planet-local space; `matrix` is the planet's render-parent world matrix (its
 * rotation maps local → world-relative-to-planet-center); `camRel*` is the
 * camera position relative to the planet center. Writes into `tmp`.
 */
function vertexBackface(
    v: Vector3,
    matrix: Matrix,
    camRelX: number, camRelY: number, camRelZ: number,
    minDot: number,
    tmp: Vector3
): boolean {
    Vector3.TransformNormalToRef(v, matrix, tmp);
    const rx = tmp.x, ry = tmp.y, rz = tmp.z; // radial = vertexWorld − planetCenter
    return isBackface(rx, ry, rz, camRelX - rx, camRelY - ry, camRelZ - rz, minDot);
}

/**
 * A triangle is back-facing (safe to cull from split candidates) only when ALL
 * THREE vertices are behind the horizon. Testing the centroid alone wrongly culls
 * huge coarse triangles that straddle the horizon — which then can never split to
 * produce front-facing children (the startup "stuck at minimum LOD" bug).
 */
function triangleBackface(
    v0: Vector3, v1: Vector3, v2: Vector3,
    matrix: Matrix,
    camRelX: number, camRelY: number, camRelZ: number,
    minDot: number,
    tmp: Vector3
): boolean {
    return (
        vertexBackface(v0, matrix, camRelX, camRelY, camRelZ, minDot, tmp) &&
        vertexBackface(v1, matrix, camRelX, camRelY, camRelZ, minDot, tmp) &&
        vertexBackface(v2, matrix, camRelX, camRelY, camRelZ, minDot, tmp)
    );
}

function triangleArea(v0: Vector3, v1: Vector3, v2: Vector3): number {
    // Inlined cross-product magnitude — no Vector3 allocations on this hot path.
    // Same component order as Vector3.Cross(v1-v0, v2-v0).length() so results are
    // bit-identical to the previous implementation (golden hash preserved).
    const e0x = v1.x - v0.x;
    const e0y = v1.y - v0.y;
    const e0z = v1.z - v0.z;
    const e1x = v2.x - v0.x;
    const e1y = v2.y - v0.y;
    const e1z = v2.z - v0.z;
    const cx = e0y * e1z - e0z * e1y;
    const cy = e0z * e1x - e0x * e1z;
    const cz = e0x * e1y - e0y * e1x;
    return Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
}

export function classifySplitCandidates({
    leaves,
    cameraWorldDouble,
    planetCenterWorldDouble,
    renderParentWorldMatrix,
    viewportHeightPx,
    cameraFovRadians,
    splitThresholdPx2,
    splitHysteresis,
}: CbtClassifyParams): CbtSplitCandidate[] {
    const focal = viewportHeightPx / (2 * Math.tan(cameraFovRadians * 0.5));
    const threshold = splitThresholdPx2 * Math.max(0.05, Math.min(1.0, splitHysteresis));

    const tmpCentroidLocal = new Vector3();
    const tmpCentroidRotated = new Vector3();
    const tmpCentroidWorld = new Vector3();

    const candidates: CbtSplitCandidate[] = [];

    for (const leaf of leaves) {
        tmpCentroidLocal
            .copyFrom(leaf.v0)
            .addInPlace(leaf.v1)
            .addInPlace(leaf.v2)
            .scaleInPlace(1 / 3);

        Vector3.TransformNormalToRef(tmpCentroidLocal, renderParentWorldMatrix, tmpCentroidRotated);
        tmpCentroidWorld.copyFrom(planetCenterWorldDouble).addInPlace(tmpCentroidRotated);

        const distance = Math.max(MIN_DISTANCE, Vector3.Distance(cameraWorldDouble, tmpCentroidWorld));
        const areaWorld = triangleArea(leaf.v0, leaf.v1, leaf.v2);
        const projectedAreaPx2 = areaWorld * (focal * focal) / (distance * distance);

        if (projectedAreaPx2 >= threshold) {
            candidates.push({
                nodeId: leaf.id,
                score: projectedAreaPx2,
                projectedAreaPx2,
            });
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

export type CbtClassifyResult = {
    /** Leaves whose projected area exceeds the split threshold, sorted desc. */
    splitCandidates: CbtSplitCandidate[];
    /** Parent ids eligible to merge (both children present, below threshold), sorted asc by area. */
    mergeParents: number[];
};

/**
 * Single-pass classification: computes each leaf's projected area exactly once
 * and derives BOTH the split candidates and the merge-parent list. This is the
 * behavior-preserving merge of {@link classifySplitCandidates} and the
 * scheduler's merge aggregation that previously ran as two O(n) passes.
 *
 * Thresholds replicate the prior code exactly:
 *  - split:  area >= splitThresholdPx2 · clamp(hysteresis, 0.05, 1)
 *  - merge:  parent has 2 leaf children AND maxChildArea <= splitThresholdPx2 · hysteresis
 */
export function classifyLeaves({
    leaves,
    cameraWorldDouble,
    planetCenterWorldDouble,
    renderParentWorldMatrix,
    viewportHeightPx,
    cameraFovRadians,
    splitThresholdPx2,
    splitHysteresis,
    cullBackface = false,
    cullMinDot = DEFAULT_CULL_MIN_DOT,
    frustumPlanes = null,
    frustumGuardScale = DEFAULT_FRUSTUM_GUARD,
}: CbtClassifyParams): CbtClassifyResult {
    const focal = viewportHeightPx / (2 * Math.tan(cameraFovRadians * 0.5));
    const splitThreshold = splitThresholdPx2 * Math.max(0.05, Math.min(1.0, splitHysteresis));
    const mergeThreshold = splitThresholdPx2 * splitHysteresis;

    const tmpCentroidLocal = new Vector3();
    const tmpCentroidRotated = new Vector3();
    const tmpCentroidWorld = new Vector3();
    const tmpVertex = new Vector3();

    // Camera position relative to the planet centre (for the horizon cull).
    const camRelX = cameraWorldDouble.x - planetCenterWorldDouble.x;
    const camRelY = cameraWorldDouble.y - planetCenterWorldDouble.y;
    const camRelZ = cameraWorldDouble.z - planetCenterWorldDouble.z;

    const splitCandidates: CbtSplitCandidate[] = [];
    const parentAgg = new Map<number, { children: number; maxAreaPx2: number }>();

    for (const leaf of leaves) {
        tmpCentroidLocal
            .copyFrom(leaf.v0)
            .addInPlace(leaf.v1)
            .addInPlace(leaf.v2)
            .scaleInPlace(1 / 3);

        Vector3.TransformNormalToRef(tmpCentroidLocal, renderParentWorldMatrix, tmpCentroidRotated);
        tmpCentroidWorld.copyFrom(planetCenterWorldDouble).addInPlace(tmpCentroidRotated);

        const distance = Math.max(MIN_DISTANCE, Vector3.Distance(cameraWorldDouble, tmpCentroidWorld));
        const areaWorld = triangleArea(leaf.v0, leaf.v1, leaf.v2);
        const projectedAreaPx2 = areaWorld * (focal * focal) / (distance * distance);

        if (projectedAreaPx2 >= splitThreshold) {
            // Backside cull applies to split candidates only — merges below still
            // see every leaf. Cull only when ALL THREE vertices are behind the
            // horizon, so big coarse triangles straddling the horizon still split.
            let culled =
                cullBackface &&
                triangleBackface(
                    leaf.v0, leaf.v1, leaf.v2,
                    renderParentWorldMatrix,
                    camRelX, camRelY, camRelZ,
                    cullMinDot,
                    tmpVertex
                );

            // Frustum cull: drop candidates whose bounding sphere is fully outside
            // the view (plus a guard band so a margin keeps refining for prefetch).
            if (!culled && frustumPlanes) {
                let br2 = 0;
                const c = tmpCentroidLocal;
                for (const v of [leaf.v0, leaf.v1, leaf.v2]) {
                    const dx = v.x - c.x, dy = v.y - c.y, dz = v.z - c.z;
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 > br2) br2 = d2;
                }
                const boundRadius = Math.sqrt(br2);
                culled = outsideFrustum(
                    tmpCentroidWorld.x - cameraWorldDouble.x,
                    tmpCentroidWorld.y - cameraWorldDouble.y,
                    tmpCentroidWorld.z - cameraWorldDouble.z,
                    boundRadius,
                    frustumPlanes,
                    frustumGuardScale
                );
            }

            if (!culled) {
                splitCandidates.push({
                    nodeId: leaf.id,
                    score: projectedAreaPx2,
                    projectedAreaPx2,
                });
            }
        }

        if (leaf.parentId !== null) {
            const prev = parentAgg.get(leaf.parentId) ?? { children: 0, maxAreaPx2: 0 };
            prev.children++;
            prev.maxAreaPx2 = Math.max(prev.maxAreaPx2, projectedAreaPx2);
            parentAgg.set(leaf.parentId, prev);
        }
    }

    splitCandidates.sort((a, b) => b.score - a.score);

    const mergeParents = Array.from(parentAgg.entries())
        .filter(([, agg]) => agg.children === 2 && agg.maxAreaPx2 <= mergeThreshold)
        .sort((a, b) => a[1].maxAreaPx2 - b[1].maxAreaPx2)
        .map(([parentId]) => parentId);

    return { splitCandidates, mergeParents };
}

export function measureLeafProjectedAreas({
    leaves,
    cameraWorldDouble,
    planetCenterWorldDouble,
    renderParentWorldMatrix,
    viewportHeightPx,
    cameraFovRadians,
}: Omit<CbtClassifyParams, 'splitThresholdPx2' | 'splitHysteresis'>): CbtLeafMetric[] {
    const focal = viewportHeightPx / (2 * Math.tan(cameraFovRadians * 0.5));
    const tmpCentroidLocal = new Vector3();
    const tmpCentroidRotated = new Vector3();
    const tmpCentroidWorld = new Vector3();

    const metrics: CbtLeafMetric[] = [];
    for (const leaf of leaves) {
        tmpCentroidLocal
            .copyFrom(leaf.v0)
            .addInPlace(leaf.v1)
            .addInPlace(leaf.v2)
            .scaleInPlace(1 / 3);

        Vector3.TransformNormalToRef(tmpCentroidLocal, renderParentWorldMatrix, tmpCentroidRotated);
        tmpCentroidWorld.copyFrom(planetCenterWorldDouble).addInPlace(tmpCentroidRotated);

        const distance = Math.max(MIN_DISTANCE, Vector3.Distance(cameraWorldDouble, tmpCentroidWorld));
        const areaWorld = triangleArea(leaf.v0, leaf.v1, leaf.v2);
        const projectedAreaPx2 = areaWorld * (focal * focal) / (distance * distance);
        metrics.push({
            nodeId: leaf.id,
            parentId: leaf.parentId,
            projectedAreaPx2,
        });
    }

    return metrics;
}
