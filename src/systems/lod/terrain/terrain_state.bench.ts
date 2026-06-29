import { bench, describe } from 'vitest';
import { FIXTURE_MAX_DEPTH, FIXTURE_RADIUS, growUniform } from './__fixtures__/terrain_fixtures';
import { TerrainState } from './terrain_state';

/**
 * Structural cost of the current `Map<number, TerrainNode>` representation:
 *  - split-storm: how fast the tree grows to N leaves;
 *  - getLeafNodes: the per-frame O(n) array materialization the scheduler pays
 *    twice (measure + classify) every update.
 *
 * Baseline for a future typed-array heap migration.
 */

const SIZES = [1000, 5000, 20000] as const;

for (const size of SIZES) {
    describe(`TerrainState ~${size} leaves`, () => {
        bench('split-storm (build tree)', () => {
            growUniform(size);
        });

        const built = growUniform(size);
        bench('getLeafNodes()', () => {
            built.getLeafNodes();
        });
    });
}

describe('TerrainState construction', () => {
    bench('new TerrainState (8 roots)', () => {
        new TerrainState(FIXTURE_RADIUS, FIXTURE_MAX_DEPTH);
    });
});
