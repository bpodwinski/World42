import { bench, describe } from 'vitest';
import { CbtEmitCache, emitMeshFromLeaves } from './cbt_emit';
import { FIXTURE_RADIUS, makeLeafSet } from './__fixtures__/cbt_fixtures';

/**
 * `emitMeshFromLeaves` runs a full mesh rebuild on every topology change. With
 * noise it samples fbmNoise per vertex (displacement) plus 4 more per vertex
 * for the finite-difference normal — by far the dominant rebuild cost.
 */

const SIZES = [1000, 5000] as const;

for (const size of SIZES) {
    const leaves = makeLeafSet(size);

    // Pre-warmed cache for the steady-state (no topology change) bench.
    const warmCache = new CbtEmitCache();
    warmCache.emit(leaves, FIXTURE_RADIUS);

    describe(`emitMeshFromLeaves ~${size} leaves`, () => {
        bench('full rebuild, with noise (pre-A3 cost)', () => {
            emitMeshFromLeaves(leaves, FIXTURE_RADIUS);
        });

        bench('full rebuild, no noise (geometry only)', () => {
            emitMeshFromLeaves(leaves, FIXTURE_RADIUS, { noise: null });
        });

        bench('incremental cached, steady state (A3, recompute=0)', () => {
            warmCache.emit(leaves, FIXTURE_RADIUS);
        });
    });
}
