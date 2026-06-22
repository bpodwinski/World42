import { describe, expect, it } from 'vitest';
import { CbtState, type CbtNode } from './cbt_state';

/**
 * Conformity guarantees for the ROAM bintree: the adaptive mesh must be
 * watertight (every interior edge shared by exactly two leaves, no T-junctions)
 * and restricted (edge-adjacent leaves differ by at most one level). These are
 * checked from `getLeafNodes()` alone, so they validate the result regardless of
 * the internal neighbour bookkeeping.
 */

const RADIUS = 1000;
const MAX_DEPTH = 24;

/** Quantize a coordinate so shared vertices (identical floats) collide. */
function q(x: number): number {
    return Math.round(x * 1e3);
}

function vkey(x: number, y: number, z: number): string {
    return `${q(x)},${q(y)},${q(z)}`;
}

function edgeKey(ax: number, ay: number, az: number, bx: number, by: number, bz: number): string {
    const a = vkey(ax, ay, az);
    const b = vkey(bx, by, bz);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

type EdgeInfo = { count: number; levels: number[] };

function collectEdges(leaves: ReadonlyArray<CbtNode>): Map<string, EdgeInfo> {
    const edges = new Map<string, EdgeInfo>();
    const add = (k: string, level: number) => {
        const e = edges.get(k);
        if (e) {
            e.count++;
            e.levels.push(level);
        } else {
            edges.set(k, { count: 1, levels: [level] });
        }
    };
    for (const leaf of leaves) {
        const { v0, v1, v2, level } = leaf;
        add(edgeKey(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z), level);
        add(edgeKey(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z), level);
        add(edgeKey(v2.x, v2.y, v2.z, v0.x, v0.y, v0.z), level);
    }
    return edges;
}

/** Refine the single leaf whose centroid is nearest `target`, N times. */
function refineNear(state: CbtState, target: [number, number, number], iterations: number): void {
    for (let i = 0; i < iterations; i++) {
        const leaves = state.getLeafNodes();
        let best = leaves[0];
        let bestD = Infinity;
        for (const leaf of leaves) {
            const cx = (leaf.v0.x + leaf.v1.x + leaf.v2.x) / 3;
            const cy = (leaf.v0.y + leaf.v1.y + leaf.v2.y) / 3;
            const cz = (leaf.v0.z + leaf.v1.z + leaf.v2.z) / 3;
            const dx = cx - target[0];
            const dy = cy - target[1];
            const dz = cz - target[2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = leaf;
            }
        }
        state.splitByPriority([best.id], 1);
    }
}

describe('CBT conformity (ROAM bintree)', () => {
    it('roots form a watertight octahedron (every edge shared by 2)', () => {
        const leaves = new CbtState(RADIUS, MAX_DEPTH).getLeafNodes();
        expect(leaves.length).toBe(8);
        const edges = collectEdges(leaves);
        for (const [, info] of edges) {
            expect(info.count).toBe(2);
        }
    });

    it('stays watertight under deep adaptive refinement', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        refineNear(state, [RADIUS, 0, 0], 200);
        const leaves = state.getLeafNodes();
        expect(leaves.length).toBeGreaterThan(20);

        const edges = collectEdges(leaves);
        let maxLevel = 0;
        for (const leaf of leaves) maxLevel = Math.max(maxLevel, leaf.level);
        expect(maxLevel).toBeGreaterThan(4); // refinement actually went deep

        // Watertight: no T-junctions — every edge borders exactly two leaves.
        for (const [, info] of edges) {
            expect(info.count).toBe(2);
        }
    });

    it('stays restricted: edge-adjacent leaves differ by at most one level', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        refineNear(state, [RADIUS, 0, 0], 200);
        const edges = collectEdges(state.getLeafNodes());
        for (const [, info] of edges) {
            if (info.levels.length === 2) {
                expect(Math.abs(info.levels[0] - info.levels[1])).toBeLessThanOrEqual(1);
            }
        }
    });

    it('refinement at multiple separate spots stays watertight', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        refineNear(state, [RADIUS, 0, 0], 80);
        refineNear(state, [0, RADIUS, 0], 80);
        refineNear(state, [0, 0, RADIUS], 80);
        const edges = collectEdges(state.getLeafNodes());
        for (const [, info] of edges) {
            expect(info.count).toBe(2);
        }
    });
});
