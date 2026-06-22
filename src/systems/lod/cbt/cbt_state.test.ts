import { describe, expect, it } from 'vitest';
import { CbtState } from './cbt_state';

describe('CbtState', () => {
    it('starts with 8 root triangles and grows leaves with conformal (diamond) splits', () => {
        const state = new CbtState(100, 4);
        expect(state.leafCount).toBe(8);

        // Roots are paired into 4 base-edge diamonds; each conformal split refines
        // a diamond (the node + its base partner), adding 2 leaves.
        const leafIds = state.getLeafNodes().map((leaf) => leaf.id);
        const splitCount = state.splitByPriority(leafIds, 3);

        expect(splitCount).toBe(3);
        expect(state.leafCount).toBe(8 + 2 * 3);
    });

    it('does not split when maxDepth is reached', () => {
        const state = new CbtState(100, 0);
        const leafIds = state.getLeafNodes().map((leaf) => leaf.id);
        const splitCount = state.splitByPriority(leafIds, 8);

        expect(splitCount).toBe(0);
        expect(state.leafCount).toBe(8);
    });

    it('merges a diamond back to its coarse pair', () => {
        const state = new CbtState(100, 4);
        const firstLeaf = state.getLeafNodes()[0];
        const splitCount = state.splitByPriority([firstLeaf.id], 1);
        expect(splitCount).toBe(1);
        expect(state.leafCount).toBe(10); // diamond split: +2

        // Collapsing the diamond restores both coarse triangles.
        const mergeCount = state.mergeByParentPriority([firstLeaf.id], 1);
        expect(mergeCount).toBe(1);
        expect(state.leafCount).toBe(8);

        const leafIds = new Set(state.getLeafNodes().map((leaf) => leaf.id));
        expect(leafIds.has(firstLeaf.id)).toBe(true);
    });
});
