import { describe, expect, it } from 'vitest';
import { CbtState } from './cbt_state';

describe('CbtState', () => {
    it('starts with 8 root triangles and grows leaves with splits', () => {
        const state = new CbtState(100, 4);
        expect(state.leafCount).toBe(8);

        const leafIds = state.getLeafNodes().map((leaf) => leaf.id);
        const splitCount = state.splitByPriority(leafIds, 3);

        expect(splitCount).toBe(3);
        expect(state.leafCount).toBe(11);
    });

    it('does not split when maxDepth is reached', () => {
        const state = new CbtState(100, 0);
        const leafIds = state.getLeafNodes().map((leaf) => leaf.id);
        const splitCount = state.splitByPriority(leafIds, 8);

        expect(splitCount).toBe(0);
        expect(state.leafCount).toBe(8);
    });

    it('merges siblings back to parent', () => {
        const state = new CbtState(100, 4);
        const firstLeaf = state.getLeafNodes()[0];
        const splitCount = state.splitByPriority([firstLeaf.id], 1);
        expect(splitCount).toBe(1);
        expect(state.leafCount).toBe(9);

        const parentId = firstLeaf.id;
        const mergeCount = state.mergeByParentPriority([parentId], 1);
        expect(mergeCount).toBe(1);
        expect(state.leafCount).toBe(8);
    });
});
