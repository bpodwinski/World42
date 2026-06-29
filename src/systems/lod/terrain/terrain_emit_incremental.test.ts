import { describe, expect, it } from 'vitest';
import { CbtEmitCache, emitMeshFromLeaves, type EmitResult } from './cbt_emit';
import { CbtState } from './cbt_state';

/**
 * The incremental emitter (CbtEmitCache) must produce byte-identical output to
 * the full emitter, while only recomputing slots whose geometry changed.
 */

const RADIUS = 1000;
const MAX_DEPTH = 24;

function refineNear(state: CbtState, target: [number, number, number], iterations: number): void {
    for (let i = 0; i < iterations; i++) {
        const leaves = state.getLeafNodes();
        let best = leaves[0];
        let bestD = Infinity;
        for (const leaf of leaves) {
            const cx = (leaf.v0.x + leaf.v1.x + leaf.v2.x) / 3;
            const cy = (leaf.v0.y + leaf.v1.y + leaf.v2.y) / 3;
            const cz = (leaf.v0.z + leaf.v1.z + leaf.v2.z) / 3;
            const d = (cx - target[0]) ** 2 + (cy - target[1]) ** 2 + (cz - target[2]) ** 2;
            if (d < bestD) {
                bestD = d;
                best = leaf;
            }
        }
        state.splitByPriority([best.id], 1);
    }
}

function expectMeshEqual(a: EmitResult, b: EmitResult): void {
    expect(a.positions).toEqual(b.positions);
    expect(a.normals).toEqual(b.normals);
    expect(a.uvs).toEqual(b.uvs);
    expect(a.colors).toEqual(b.colors);
    expect(a.morphDeltas).toEqual(b.morphDeltas);
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
}

describe('CbtEmitCache (incremental mesh)', () => {
    it('matches the full emitter byte-for-byte', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        refineNear(state, [RADIUS, 0, 0], 120);
        const leaves = state.getLeafNodes();

        const full = emitMeshFromLeaves(leaves, RADIUS);
        const cache = new CbtEmitCache();
        const inc = cache.emit(leaves, RADIUS);

        expectMeshEqual(inc, full);
    });

    it('stays identical after further refinement (cache reuse + invalidation)', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        const cache = new CbtEmitCache();

        refineNear(state, [RADIUS, 0, 0], 60);
        cache.emit(state.getLeafNodes(), RADIUS); // warm the cache

        refineNear(state, [0, RADIUS, 0], 60); // change topology elsewhere
        const leaves = state.getLeafNodes();
        const inc = cache.emit(leaves, RADIUS);
        const full = emitMeshFromLeaves(leaves, RADIUS);

        expectMeshEqual(inc, full);
    });

    it('recomputes nothing when the tree is unchanged', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        refineNear(state, [RADIUS, 0, 0], 80);
        const leaves = state.getLeafNodes();

        const cache = new CbtEmitCache();
        cache.emit(leaves, RADIUS);
        expect(cache.recomputed).toBeGreaterThan(0); // first pass computes all

        cache.emit(leaves, RADIUS);
        expect(cache.recomputed).toBe(0); // second pass: pure cache hit
    });

    it('recomputes only the changed slots after a single split', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        refineNear(state, [RADIUS, 0, 0], 80);
        const cache = new CbtEmitCache();
        cache.emit(state.getLeafNodes(), RADIUS);

        // Split a guaranteed-shallow leaf (well below maxDepth) so the split is a
        // no-op risk-free; it changes only a few slots (diamond + forced chain).
        const shallow = state
            .getLeafNodes()
            .reduce((a, b) => (a.level <= b.level ? a : b));
        state.splitByPriority([shallow.id], 1);

        const leaves = state.getLeafNodes();
        cache.emit(leaves, RADIUS);

        expect(cache.recomputed).toBeGreaterThan(0);
        expect(cache.recomputed).toBeLessThan(leaves.length / 2); // incremental, not full
    });
});
