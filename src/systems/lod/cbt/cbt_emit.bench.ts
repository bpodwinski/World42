import { bench, describe } from 'vitest';
import { emitMeshFromLeaves } from './cbt_emit';
import { FIXTURE_RADIUS, makeLeafSet } from './__fixtures__/cbt_fixtures';

/**
 * `emitMeshFromLeaves` runs a full mesh rebuild on every topology change. With
 * noise it samples fbmNoise per vertex (displacement) plus 4 more per vertex
 * for the finite-difference normal — by far the dominant rebuild cost.
 */

const SIZES = [1000, 5000] as const;

for (const size of SIZES) {
    const leaves = makeLeafSet(size);

    describe(`emitMeshFromLeaves ~${size} leaves`, () => {
        bench('with noise (DEFAULT_NOISE)', () => {
            emitMeshFromLeaves(leaves, FIXTURE_RADIUS);
        });

        bench('no noise (geometry only)', () => {
            emitMeshFromLeaves(leaves, FIXTURE_RADIUS, { noise: null });
        });
    });
}
