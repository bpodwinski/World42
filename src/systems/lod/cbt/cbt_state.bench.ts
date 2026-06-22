import { bench, describe } from 'vitest';
import { FIXTURE_MAX_DEPTH, FIXTURE_RADIUS, growUniform } from './__fixtures__/cbt_fixtures';
import { CbtState } from './cbt_state';

/**
 * Structural cost of the current `Map<number, CbtNode>` representation:
 *  - split-storm: how fast the tree grows to N leaves;
 *  - getLeafNodes: the per-frame O(n) array materialization the scheduler pays
 *    twice (measure + classify) every update.
 *
 * Baseline for a future typed-array heap migration.
 */

const SIZES = [1000, 5000, 20000] as const;

for (const size of SIZES) {
    describe(`CbtState ~${size} leaves`, () => {
        bench('split-storm (build tree)', () => {
            growUniform(size);
        });

        const built = growUniform(size);
        bench('getLeafNodes()', () => {
            built.getLeafNodes();
        });
    });
}

describe('CbtState construction', () => {
    bench('new CbtState (8 roots)', () => {
        new CbtState(FIXTURE_RADIUS, FIXTURE_MAX_DEPTH);
    });
});
