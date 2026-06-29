import { bench, describe } from 'vitest';
import {
    classifyLeaves,
    classifySplitCandidates,
    measureLeafProjectedAreas,
} from './terrain_classify';
import { makeClassifyParams, makeLeafSet } from './__fixtures__/terrain_fixtures';

/**
 * Classify is the per-frame hot path. Today `TerrainPlanet.update` runs BOTH
 * `measureLeafProjectedAreas` and `classifySplitCandidates` over the same
 * leaves (two O(n) passes). These benches establish the baseline so Phase 1's
 * single-pass `classifyLeaves` can be measured against the sum of the two.
 */

const SIZES = [1000, 5000, 20000] as const;

for (const size of SIZES) {
    const leaves = makeLeafSet(size);
    const params = makeClassifyParams(leaves);
    const measureParams = {
        leaves: params.leaves,
        cameraWorldDouble: params.cameraWorldDouble,
        planetCenterWorldDouble: params.planetCenterWorldDouble,
        renderParentWorldMatrix: params.renderParentWorldMatrix,
        viewportHeightPx: params.viewportHeightPx,
        cameraFovRadians: params.cameraFovRadians,
    };

    describe(`classify ~${size} leaves`, () => {
        bench('classifySplitCandidates', () => {
            classifySplitCandidates(params);
        });

        bench('measureLeafProjectedAreas', () => {
            measureLeafProjectedAreas(measureParams);
        });

        // True pre-Phase-1 per-frame cost: measure pass + classify pass + the
        // scheduler's merge aggregation over the metrics (old terrain_scheduler).
        bench('measure + classify + merge-agg (pre-Phase-1 update cost)', () => {
            const metrics = measureLeafProjectedAreas(measureParams);
            classifySplitCandidates(params);
            const mergeThreshold = params.splitThresholdPx2 * params.splitHysteresis;
            const agg = new Map<number, { children: number; maxAreaPx2: number }>();
            for (const m of metrics) {
                if (m.parentId === null) continue;
                const prev = agg.get(m.parentId) ?? { children: 0, maxAreaPx2: 0 };
                prev.children++;
                prev.maxAreaPx2 = Math.max(prev.maxAreaPx2, m.projectedAreaPx2);
                agg.set(m.parentId, prev);
            }
            Array.from(agg.entries())
                .filter(([, a]) => a.children === 2 && a.maxAreaPx2 <= mergeThreshold)
                .sort((a, b) => a[1].maxAreaPx2 - b[1].maxAreaPx2)
                .map(([id]) => id);
        });

        bench('classifyLeaves (Phase 1 single pass)', () => {
            classifyLeaves(params);
        });
    });
}
