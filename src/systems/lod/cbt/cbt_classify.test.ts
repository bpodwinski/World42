import { Matrix, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { classifySplitCandidates } from './cbt_classify';
import type { CbtNode } from './cbt_state';

function makeLeaf(id: number, v0: Vector3, v1: Vector3, v2: Vector3): CbtNode {
    return {
        id,
        level: 0,
        parentId: null,
        leftId: null,
        rightId: null,
        v0,
        v1,
        v2,
        isLeaf: true,
    };
}

describe('classifySplitCandidates', () => {
    it('orders candidates by projected area', () => {
        const largeLeaf = makeLeaf(
            1,
            new Vector3(1, 0, 0),
            new Vector3(0, 1, 0),
            new Vector3(0, 0, 1)
        );

        const smallLeaf = makeLeaf(
            2,
            new Vector3(0.1, 0, 0),
            new Vector3(0, 0.1, 0),
            new Vector3(0, 0, 0.1)
        );

        const candidates = classifySplitCandidates({
            leaves: [smallLeaf, largeLeaf],
            cameraWorldDouble: new Vector3(0, 0, 10),
            planetCenterWorldDouble: Vector3.Zero(),
            renderParentWorldMatrix: Matrix.Identity(),
            viewportHeightPx: 1080,
            cameraFovRadians: 1.2,
            splitThresholdPx2: 1,
            splitHysteresis: 1,
        });

        expect(candidates.length).toBe(2);
        expect(candidates[0].nodeId).toBe(1);
        expect(candidates[0].projectedAreaPx2).toBeGreaterThan(candidates[1].projectedAreaPx2);
    });
});
