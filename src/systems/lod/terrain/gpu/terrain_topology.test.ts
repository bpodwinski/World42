import { describe, it, expect } from 'vitest';
import { OcbtTopology, type BisectorView } from './ocbt_topology';
import { ocbtCorners } from './ocbt_eval_leb';

type V3 = [number, number, number];

const keyOf = (v: readonly number[]) =>
    `${v[0].toFixed(9)},${v[1].toFixed(9)},${v[2].toFixed(9)}`;
const edgeKey = (p: readonly number[], q: readonly number[]) => {
    const a = keyOf(p);
    const b = keyOf(q);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
};

/** Watertight iff every undirected leaf-triangle edge is shared by exactly 2 leaves. */
function watertightViolations(leaves: BisectorView[]): number {
    const counts = new Map<string, number>();
    for (const t of leaves) {
        for (const [p, q] of [
            [t.a, t.l],
            [t.l, t.r],
            [t.r, t.a]
        ] as [V3, V3][]) {
            const k = edgeKey(p, q);
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
    }
    let bad = 0;
    for (const c of counts.values()) if (c !== 2) bad++;
    return bad;
}

/** Every leaf's non-null neighbor must be a leaf that lists it back (ValidateBisector). */
function symmetryViolations(leaves: BisectorView[]): number {
    const bySlot = new Map<number, BisectorView>();
    for (const t of leaves) bySlot.set(t.slot, t);
    let bad = 0;
    for (const t of leaves) {
        for (const n of t.neighbors) {
            if (n < 0) continue;
            const nb = bySlot.get(n);
            if (!nb || !nb.neighbors.includes(t.slot)) bad++;
        }
    }
    return bad;
}

const near = (p: V3, q: readonly number[], tol = 1e-6) =>
    Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
/**
 * Stored verts and the canonical decode `ocbtCorners(heapID)` must describe the same
 * triangle (set-matched within tolerance). The oracle now stores geometry straight from
 * ocbtCorners, so this guards that heapID<->geometry wiring stays consistent.
 */
function heapIdConsistencyViolations(leaves: BisectorView[]): number {
    let bad = 0;
    for (const t of leaves) {
        const cand = ocbtCorners(t.heapID);
        for (const s of [t.a, t.l, t.r]) {
            if (!cand.some((c) => near(s, c))) bad++;
        }
    }
    return bad;
}

const centroid = (t: BisectorView): V3 => {
    const x = t.a[0] + t.l[0] + t.r[0];
    const y = t.a[1] + t.l[1] + t.r[1];
    const z = t.a[2] + t.l[2] + t.r[2];
    const i = 1 / Math.hypot(x, y, z);
    return [x * i, y * i, z * i];
};

function checkAll(topo: OcbtTopology): void {
    const leaves = topo.leaves();
    expect(watertightViolations(leaves)).toBe(0);
    expect(symmetryViolations(leaves)).toBe(0);
    expect(heapIdConsistencyViolations(leaves)).toBe(0);
}

describe('OcbtTopology — octahedron seed', () => {
    it('seeds 8 leaves with heap ids 8..15 and is watertight + symmetric', () => {
        const topo = new OcbtTopology(20);
        const leaves = topo.leaves();
        expect(leaves.length).toBe(8);
        expect(topo.leafCount).toBe(8);
        expect(leaves.map((l) => l.heapID).sort((a, b) => a - b)).toEqual([
            8, 9, 10, 11, 12, 13, 14, 15
        ]);
        for (const l of leaves) expect(l.depth).toBe(3);
        checkAll(topo);
    });
});

describe('OcbtTopology — single split forces the diamond', () => {
    it('splitting one root also splits its base diamond partner, staying watertight', () => {
        const topo = new OcbtTopology(20);
        const before = topo.leafCount;
        topo.requestSplit(0); // root 0; base neighbour is root 4 (the diamond)
        // root + diamond partner each split into 2 => +2 leaves.
        expect(topo.leafCount).toBe(before + 2);
        checkAll(topo);
    });
});

describe('OcbtTopology — deep local refinement (fly-in)', () => {
    it('repeatedly splitting toward a target stays watertight + symmetric across seams', () => {
        // maxDepth (30) is kept well above the refinement target (SOFT_TARGET) so the
        // forced-diamond chain always completes — the chain may go one level past the
        // requested leaf, and stranding it at a hard cap is a separate Phase 1c concern
        // (the reference reserves the whole chain atomically and refuses if it cannot).
        const SOFT_TARGET = 18;
        const topo = new OcbtTopology(30);
        const target: V3 = (() => {
            const i = 1 / Math.hypot(0.3, 0.7, 0.5);
            return [0.3 * i, 0.7 * i, 0.5 * i];
        })();
        for (let iter = 0; iter < 400; iter++) {
            const leaves = topo.leaves();
            // Pick the leaf whose centroid is closest to the target and is splittable.
            let best = -1;
            let bestDot = -Infinity;
            for (const t of leaves) {
                if (t.depth - 3 >= SOFT_TARGET) continue;
                const c = centroid(t);
                const d = c[0] * target[0] + c[1] * target[1] + c[2] * target[2];
                if (d > bestDot) {
                    bestDot = d;
                    best = t.slot;
                }
            }
            if (best < 0) break;
            topo.requestSplit(best);
            if (iter % 50 === 0) checkAll(topo); // periodic full check (O(n) each)
        }
        // Final state: deep refinement, must still be watertight.
        checkAll(topo);
        const leaves = topo.leaves();
        const maxDepth = Math.max(...leaves.map((l) => l.depth));
        expect(maxDepth).toBeGreaterThan(8); // genuinely refined deep near the target
    });
});

describe('OcbtTopology — multi-region refinement (LEPP, watertight)', () => {
    // Several simultaneous hot-spots meeting at coarse boundaries — the case base-only
    // forcing cracked. With the LEPP conforming split this must be fully watertight.
    it('refining toward several targets at once stays watertight + symmetric', () => {
        const SOFT_TARGET = 16;
        const topo = new OcbtTopology(30);
        const targets: V3[] = [
            [0.3, 0.7, 0.5],
            [-0.6, 0.2, -0.4],
            [0.1, -0.9, 0.2],
            [-0.2, -0.3, 0.93]
        ].map((t) => {
            const i = 1 / Math.hypot(t[0], t[1], t[2]);
            return [t[0] * i, t[1] * i, t[2] * i];
        });
        for (let iter = 0; iter < 500; iter++) {
            const target = targets[iter % targets.length];
            const leaves = topo.leaves();
            let best = -1;
            let bestDot = -Infinity;
            for (const t of leaves) {
                if (t.depth - 3 >= SOFT_TARGET) continue;
                const c = centroid(t);
                const d = c[0] * target[0] + c[1] * target[1] + c[2] * target[2];
                if (d > bestDot) {
                    bestDot = d;
                    best = t.slot;
                }
            }
            if (best < 0) break;
            topo.requestSplit(best);
        }
        checkAll(topo);
        expect(topo.leafCount).toBeGreaterThan(200); // genuinely refined in multiple regions
    });
});

describe('OcbtTopology — refinement driven INTO the depth cap', () => {
    // The old base-only forcing cracked when refinement piled at maxDepth (the forced
    // partner could not split past the cap). LEPP only propagates toward COARSER nodes,
    // so driving to the cap should stay watertight (splits at the cap are simply refused
    // by the entry guard; their same-level cap neighbours share full edges).
    it('greedy refine with target depth == maxDepth stays watertight', () => {
        const MAXD = 12;
        const topo = new OcbtTopology(MAXD);
        const target: V3 = (() => {
            const i = 1 / Math.hypot(0.3, 0.7, 0.5);
            return [0.3 * i, 0.7 * i, 0.5 * i];
        })();
        for (let iter = 0; iter < 1200; iter++) {
            const leaves = topo.leaves();
            let best = -1;
            let bestDot = -Infinity;
            for (const t of leaves) {
                if (t.depth - 3 >= MAXD) continue; // only the entry-guard cap, no soft headroom
                const c = centroid(t);
                const d = c[0] * target[0] + c[1] * target[1] + c[2] * target[2];
                if (d > bestDot) {
                    bestDot = d;
                    best = t.slot;
                }
            }
            if (best < 0) break;
            topo.requestSplit(best);
        }
        checkAll(topo);
        // genuinely reached the cap
        expect(Math.max(...topo.leaves().map((l) => l.depth - 3))).toBe(MAXD);
    });

    it('random refine with target depth == maxDepth stays watertight', () => {
        const MAXD = 11;
        const topo = new OcbtTopology(MAXD);
        let s = 0x0d15ea5e >>> 0;
        const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
        for (let iter = 0; iter < 4000; iter++) {
            const leaves = topo.leaves();
            const pick = leaves[Math.floor(rnd() * leaves.length)];
            if (pick && pick.depth - 3 < MAXD) topo.requestSplit(pick.slot);
        }
        checkAll(topo);
    });
});

describe('OcbtTopology — arbitrary random refinement (LEPP, watertight)', () => {
    // The adversarial case: split random leaves with no coherence. LEPP must keep the
    // mesh watertight + symmetric regardless (base-only forcing produced T-junctions
    // here — see git history of this test).
    it('many random splits stay watertight + symmetric', () => {
        const SOFT_TARGET = 14;
        const topo = new OcbtTopology(30);
        let s = 0x51ed_2701 >>> 0;
        const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
        for (let iter = 0; iter < 800; iter++) {
            const leaves = topo.leaves();
            const pick = leaves[Math.floor(rnd() * leaves.length)];
            if (pick && pick.depth - 3 < SOFT_TARGET) topo.requestSplit(pick.slot);
        }
        checkAll(topo);
        expect(topo.leafCount).toBeGreaterThan(200);
    });

    it('multiple independent seeds all stay watertight', () => {
        for (const seed of [1, 7, 42, 1337, 0xbeef]) {
            const topo = new OcbtTopology(28);
            let s = seed >>> 0;
            const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
            for (let iter = 0; iter < 400; iter++) {
                const leaves = topo.leaves();
                const pick = leaves[Math.floor(rnd() * leaves.length)];
                if (pick && pick.depth - 3 < 13) topo.requestSplit(pick.slot);
            }
            const leaves = topo.leaves();
            expect(watertightViolations(leaves)).toBe(0);
            expect(symmetryViolations(leaves)).toBe(0);
        }
    });
});

describe('OcbtTopology — conservative merge', () => {
    it('merging back the freshly split diamonds restores the seed and stays watertight', () => {
        const topo = new OcbtTopology(20);
        // Split every root once (each pulls in its diamond partner).
        for (let r = 0; r < 8; r++) topo.requestSplit(r);
        checkAll(topo);
        const refined = topo.leafCount;
        expect(refined).toBeGreaterThan(8);

        // Merge: the parents are the original roots 0..7 (now internal).
        topo.mergeSlots([0, 1, 2, 3, 4, 5, 6, 7]);
        checkAll(topo);
        expect(topo.leafCount).toBe(8);
        expect(topo.leaves().map((l) => l.heapID).sort((a, b) => a - b)).toEqual([
            8, 9, 10, 11, 12, 13, 14, 15
        ]);
    });

    // Deep multi-level refinement then a full greedy collapse. This exercises the
    // conservative-merge guards (same-level reciprocal diamond + no finer neighbour) on
    // diamonds whose legs are refined — the path a weak "merge low slots" test missed
    // and where merge() previously corrupted the mesh (audit-confirmed). It must stay
    // watertight at every pass and round-trip EXACTLY to the 8-face seed.
    it('greedy full merge of a deeply refined mesh round-trips to the seed, watertight throughout', () => {
        for (const seed of [1, 7, 99, 2718]) {
            const topo = new OcbtTopology(30);
            let s = seed >>> 0;
            const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
            // Build a watertight, multi-level mesh.
            for (let iter = 0; iter < 600; iter++) {
                const leaves = topo.leaves();
                const pick = leaves[Math.floor(rnd() * leaves.length)];
                if (pick && pick.depth - 3 < 13) topo.requestSplit(pick.slot);
            }
            checkAll(topo);
            expect(topo.leafCount).toBeGreaterThan(100);

            // Greedily merge every collapsible diamond, pass after pass, until stable.
            let guard = 0;
            for (;;) {
                const all = Array.from({ length: topo.slotCount }, (_, i) => i);
                const merged = topo.mergeSlots(all);
                checkAll(topo); // watertight + symmetric after every pass
                if (merged === 0) break;
                if (++guard > 200) throw new Error('merge did not converge');
            }
            // A conforming mesh fully collapses back to the octahedron seed.
            expect(topo.leafCount).toBe(8);
            expect(topo.leaves().map((l) => l.heapID).sort((a, b) => a - b)).toEqual([
                8, 9, 10, 11, 12, 13, 14, 15
            ]);
        }
    });
});
