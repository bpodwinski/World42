import { Matrix, Vector3 } from '@babylonjs/core';
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
};

const MIN_DISTANCE = 1.0;

function triangleArea(v0: Vector3, v1: Vector3, v2: Vector3): number {
    const e0 = v1.subtract(v0);
    const e1 = v2.subtract(v0);
    return Vector3.Cross(e0, e1).length() * 0.5;
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
    const threshold = splitThresholdPx2;

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
