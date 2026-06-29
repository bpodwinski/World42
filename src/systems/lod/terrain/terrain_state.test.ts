import { describe, expect, it } from 'vitest';
import { TerrainState } from './terrain_state';

describe('TerrainState', () => {
    it('starts with 8 root triangles and grows leaves with conformal (diamond) splits', () => {
        const state = new TerrainState(100, 4);
        expect(state.leafCount).toBe(8);

        // Roots are paired into 4 base-edge diamonds; each conformal split refines
        // a diamond (the node + its base partner), adding 2 leaves.
        const leafIds = state.getLeafNodes().map((leaf) => leaf.id);
        const splitCount = state.splitByPriority(leafIds, 3);

        expect(splitCount).toBe(3);
        expect(state.leafCount).toBe(8 + 2 * 3);
    });

    it('does not split when maxDepth is reached', () => {
        const state = new TerrainState(100, 0);
        const leafIds = state.getLeafNodes().map((leaf) => leaf.id);
        const splitCount = state.splitByPriority(leafIds, 8);

        expect(splitCount).toBe(0);
        expect(state.leafCount).toBe(8);
    });

    it('merges a diamond back to its coarse pair', () => {
        const state = new TerrainState(100, 4);
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

    it('keeps finite vertices when refinement grows the pool past its initial capacity', () => {
        // Regression: subdivide() must write child verts into the LIVE verts array. The
        // pool starts at 4096 slots and doubles on demand; a stale array reference cached
        // before allocSlot() would send writes to the orphaned old array, leaving slots
        // past the grow boundary with 0/NaN verts. Refine deeply enough to force a grow.
        const state = new TerrainState(100, 15);
        // Uniform refinement: split every current leaf each pass (~doubles the leaf
        // count), so after ~10 passes we have >4096 slots and have crossed >=1 grow.
        for (let pass = 0; pass < 10; pass++) {
            const ids = state.getLeafNodes().map((leaf) => leaf.id);
            state.splitByPriority(ids, ids.length);
        }
        const leaves = state.getLeafNodes();
        // >2048 leaves => >4096 slots => the pool grew at least once.
        expect(leaves.length).toBeGreaterThan(2048);
        let nonFinite = 0;
        for (const t of leaves) {
            for (const v of [t.v0, t.v1, t.v2]) {
                if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
                    nonFinite++;
                }
            }
        }
        expect(nonFinite).toBe(0);
    });
});
