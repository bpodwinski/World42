import { describe, it, expect } from 'vitest';
import { TerrainTopology, type BisectorView } from './terrain_topology';
import { terrainCorners } from './terrain_eval_leb';

type V3 = [number, number, number];

// Robust integer quantization (handles -0; +0 collapses -0 -> 0). 1e7 over the unit
// sphere is far finer than any real edge here, far coarser than FP accumulation noise.
const q = (x: number) => Math.round(x * 1e7) + 0;
const keyOf = (v: readonly number[]) => `${q(v[0])},${q(v[1])},${q(v[2])}`;
const edgeKey = (p: readonly number[], r: readonly number[]) => {
    const a = keyOf(p);
    const b = keyOf(r);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
};

function watertightViolations(leaves: BisectorView[]): number {
    const c = new Map<string, number>();
    for (const t of leaves) {
        for (const [p, r] of [
            [t.a, t.l],
            [t.l, t.r],
            [t.r, t.a]
        ] as [V3, V3][]) {
            const k = edgeKey(p, r);
            c.set(k, (c.get(k) ?? 0) + 1);
        }
    }
    let bad = 0;
    for (const v of c.values()) if (v !== 2) bad++;
    return bad;
}
function symmetryViolations(leaves: BisectorView[]): number {
    const by = new Map<number, BisectorView>();
    for (const t of leaves) by.set(t.slot, t);
    let bad = 0;
    for (const t of leaves) {
        for (const n of t.neighbors) {
            if (n < 0) continue;
            const nb = by.get(n);
            if (!nb || !nb.neighbors.includes(t.slot)) bad++;
        }
    }
    return bad;
}
const near = (p: V3, qv: readonly number[], tol = 1e-6) =>
    Math.hypot(p[0] - qv[0], p[1] - qv[1], p[2] - qv[2]) < tol;
function heapIdViolations(leaves: BisectorView[]): number {
    let bad = 0;
    for (const t of leaves) {
        const cand = terrainCorners(t.heapID);
        for (const s of [t.a, t.l, t.r]) if (!cand.some((c) => near(s, c))) bad++;
    }
    return bad;
}
function assertSound(topo: TerrainTopology, label: string): void {
    const leaves = topo.leaves();
    expect(watertightViolations(leaves), `${label}: watertight`).toBe(0);
    expect(symmetryViolations(leaves), `${label}: symmetry`).toBe(0);
    expect(heapIdViolations(leaves), `${label}: heapID`).toBe(0);
    // every undirected edge manifold => no degenerate / NaN verts
    for (const t of leaves) {
        for (const v of [t.a, t.l, t.r]) {
            expect(Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])).toBe(true);
        }
    }
}
const lcg = (seed: number) => {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
};
const centroid = (t: BisectorView): V3 => {
    const x = t.a[0] + t.l[0] + t.r[0];
    const y = t.a[1] + t.l[1] + t.r[1];
    const z = t.a[2] + t.l[2] + t.r[2];
    const i = 1 / Math.hypot(x, y, z);
    return [x * i, y * i, z * i];
};

describe('TerrainTopology stress — crosses multiple grow() boundaries', () => {
    // Depth cap 19 keeps edges (~1e-5 on the unit sphere) well above the test's 1e-7
    // quantization grid (so shared verts collapse, distinct ones don't) while still
    // forcing >=2 pool grows (4096 -> 8192 -> 16384 slots). Deeper than ~20 the
    // quantized watertight check itself becomes unreliable, not the topology.
    it(
        'deep random refinement past 8192 slots stays watertight (>=2 grows)',
        () => {
            const topo = new TerrainTopology(40);
            const rnd = lcg(0x1234_abcd);
            for (let iter = 0; iter < 7000; iter++) {
                const leaves = topo.leaves();
                const pick = leaves[Math.floor(rnd() * leaves.length)];
                if (pick && pick.depth - 3 < 18) topo.requestSplit(pick.slot);
            }
            // > 4096 leaves => > 8192 slots => crossed the 4096 AND 8192 slot grows.
            expect(topo.leafCount).toBeGreaterThan(4096);
            assertSound(topo, 'deep-random');
        },
        30000
    );
});

describe('TerrainTopology stress — pole and seam targeting', () => {
    it('refining hard at the +y pole (all 4 top faces meet) stays watertight', () => {
        const topo = new TerrainTopology(34);
        const pole: V3 = [0, 1, 0];
        for (let iter = 0; iter < 1500; iter++) {
            const leaves = topo.leaves();
            let best = -1;
            let bestDot = -Infinity;
            for (const t of leaves) {
                if (t.depth - 3 >= 20) continue;
                const c = centroid(t);
                const d = c[0] * pole[0] + c[1] * pole[1] + c[2] * pole[2];
                if (d > bestDot) {
                    bestDot = d;
                    best = t.slot;
                }
            }
            if (best < 0) break;
            topo.requestSplit(best);
        }
        assertSound(topo, 'pole');
    });

    it('refining along an equatorial seam edge stays watertight', () => {
        const topo = new TerrainTopology(34);
        const seamDir: V3 = (() => {
            const i = 1 / Math.hypot(1, 0, 1);
            return [i, 0, i]; // on the +x/+z seam between faces
        })();
        for (let iter = 0; iter < 1500; iter++) {
            const leaves = topo.leaves();
            let best = -1;
            let bestDot = -Infinity;
            for (const t of leaves) {
                if (t.depth - 3 >= 20) continue;
                const c = centroid(t);
                const d = c[0] * seamDir[0] + c[1] * seamDir[1] + c[2] * seamDir[2];
                if (d > bestDot) {
                    bestDot = d;
                    best = t.slot;
                }
            }
            if (best < 0) break;
            topo.requestSplit(best);
        }
        assertSound(topo, 'seam');
    });
});

describe('TerrainTopology stress — interleaved split + merge', () => {
    it('random split/merge churn stays watertight throughout', () => {
        const topo = new TerrainTopology(30);
        const rnd = lcg(0xfeed_face);
        for (let iter = 0; iter < 3000; iter++) {
            if (rnd() < 0.35 && topo.leafCount > 8) {
                // Real merge: try a random ACTUAL internal slot (merge() refuses non-
                // collapsible ones), so this exercises cross-level diamond candidates.
                topo.mergeSlots([Math.floor(rnd() * topo.slotCount)], 1);
            } else {
                const leaves = topo.leaves();
                const pick = leaves[Math.floor(rnd() * leaves.length)];
                if (pick && pick.depth - 3 < 15) topo.requestSplit(pick.slot);
            }
            if (iter % 400 === 0) assertSound(topo, `churn@${iter}`);
        }
        assertSound(topo, 'churn-final');
    });
});

describe('TerrainTopology stress — many independent deep seeds', () => {
    it('20 seeds of multi-target refinement all stay watertight', () => {
        const targetSets: V3[][] = [];
        for (let g = 0; g < 4; g++) {
            const r = lcg(0xa11ce + g * 97);
            const set: V3[] = [];
            for (let k = 0; k < 3; k++) {
                const x = r() * 2 - 1;
                const y = r() * 2 - 1;
                const z = r() * 2 - 1;
                const i = 1 / Math.hypot(x, y, z);
                set.push([x * i, y * i, z * i]);
            }
            targetSets.push(set);
        }
        for (let seed = 0; seed < 20; seed++) {
            const topo = new TerrainTopology(30);
            const rnd = lcg(0x2025 + seed * 131);
            const targets = targetSets[seed % targetSets.length];
            for (let iter = 0; iter < 600; iter++) {
                const target = targets[iter % targets.length];
                const leaves = topo.leaves();
                let best = -1;
                let bestDot = -Infinity;
                for (const t of leaves) {
                    if (t.depth - 3 >= 15) continue;
                    const c = centroid(t);
                    // jitter the metric per seed so refinement orders differ
                    const j = 1 + 0.05 * (rnd() - 0.5);
                    const d = (c[0] * target[0] + c[1] * target[1] + c[2] * target[2]) * j;
                    if (d > bestDot) {
                        bestDot = d;
                        best = t.slot;
                    }
                }
                if (best < 0) break;
                topo.requestSplit(best);
            }
            assertSound(topo, `seed-${seed}`);
        }
    });
});
