/**
 * Regression guard for the GPU CBT conforming split (Phase 3b). Ports the WGSL
 * decode (cbt_leb.wgsl, Dupuy split convention) + same-depth neighbor decode
 * (cbt_conform.wgsl) to JS and proves a metric-driven refinement is watertight
 * WITHIN each octahedron face — zero intra-face T-junctions — both sequentially
 * (reduce after each split) and in batch (split-all-then-reduce = how the GPU
 * pass applies it). The remaining T-junctions are the 12 cross-face seams, which
 * the cross-face neighbor remap (still to do) will close.
 *
 * The decode/neighbor logic here MUST stay bit-identical to the WGSL; if the
 * shaders change, update this port to match.
 */
import { describe, it, expect } from 'vitest';
import { CbtCpuHeap } from './gpu_cbt_buffers';

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Face corners as (apex=pole, L, R); equatorial hypotenuse = (L,R).
const FACE_ALR: ReadonlyArray<[V3, V3, V3]> = [
    [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 1, 0], [0, 0, 1], [-1, 0, 0]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, -1, 0], [0, 0, 1], [-1, 0, 0]],
    [[0, -1, 0], [-1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
];

// Dupuy convention: split edge = (v0,v2), M = mid(v0,v2); child0=(v0,M,v1),
// child1=(v1,M,v2). Feed face as (v0=L, v1=apex, v2=R) so first split bisects (L,R).
function lebDecode(id: number, depth: number): [V3, V3, V3] {
    const face = (id >> (depth - 3)) - 8;
    const fc = FACE_ALR[face];
    let v0: V3 = fc[1], v1: V3 = fc[0], v2: V3 = fc[2];
    const steps = depth - 3;
    for (let s = 0; s < steps; s++) {
        const bit = (id >> (steps - 1 - s)) & 1;
        const m = norm(add(v0, v2));
        if (bit === 0) { [v0, v1, v2] = [v0, m, v1]; } else { [v0, v1, v2] = [v1, m, v2]; }
    }
    return [v0, v1, v2];
}

function neighbors(localId: number, localDepth: number) {
    let nLeft = 0, nRight = 0, nEdge = 0, nNode = 1;
    for (let bit = localDepth - 1; bit >= 0; bit--) {
        const splitBit = (localId >> bit) & 1;
        const n1 = nLeft, n2 = nRight, n3 = nEdge, n4 = nNode;
        const b2 = n2 !== 0 ? 1 : 0;
        const b3 = n3 !== 0 ? 1 : 0;
        if (splitBit === 0) { nLeft = (n4 << 1) | 1; nRight = (n3 << 1) | b3; nEdge = (n2 << 1) | b2; nNode = n4 << 1; }
        else { nLeft = n3 << 1; nRight = n4 << 1; nEdge = n1 << 1; nNode = (n4 << 1) | 1; }
    }
    return { left: nLeft, right: nRight, edge: nEdge, node: nNode };
}
const edgeNeighborLocal = (id: number, d: number) => neighbors(id, d).edge;
const localToFull = (f: number, id: number, d: number): number => ((8 + f) << d) | (id & ((1 << d) - 1));
const Q = 1e5;
const vk = (v: V3) => `${Math.round(v[0] * Q)},${Math.round(v[1] * Q)},${Math.round(v[2] * Q)}`;
const ek = (a: V3, b: V3) => { const ka = vk(a), kb = vk(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };

function rawSplit(h: CbtCpuHeap, f: number, id: number, d: number): void {
    const full = localToFull(f, id, d); const depth = d + 3; const rc = (full << 1) | 1;
    h.setBit(h.bfIndex(rc, depth + 1), 1);
}
function splitConforming(h: CbtCpuHeap, f: number, id0: number, d0: number, D: number): void {
    rawSplit(h, f, id0, d0);
    let eid = edgeNeighborLocal(id0, d0); let ed = d0;
    for (let i = 0; i < D; i++) {
        if (eid <= 1) break;
        rawSplit(h, f, eid, ed);
        eid = eid >> 1; ed = ed - 1;
        rawSplit(h, f, eid, ed);
        eid = edgeNeighborLocal(eid, ed);
    }
}
function tjCheck(h: CbtCpuHeap) {
    const count = h.nodeCount();
    const verts = new Set<string>(); const leaves: Array<[V3, V3, V3]> = [];
    for (let hd = 0; hd < count; hd++) {
        const { id, depth } = h.decode(hd); if (depth < 3) continue;
        const t = lebDecode(id, depth); leaves.push(t); for (const v of t) verts.add(vk(v));
    }
    let total = 0, interior = 0, seam = 0;
    const ce = (a: V3, b: V3) => { const m = norm(add(a, b)); if (verts.has(vk(m))) { total++; if (Math.min(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2])) < 1e-4) seam++; else interior++; } };
    for (const [a, l, r] of leaves) { ce(a, l); ce(l, r); ce(r, a); }
    return { total, interior, seam, leaves: leaves.length };
}
function refine(mode: 'sequential' | 'batch', D: number, maxExtra: number) {
    const h = new CbtCpuHeap(D); h.seedLevel(3); h.sumReduce();
    const P = norm([0.37, 0.62, 0.55]);
    for (let iter = 0; iter < 80; iter++) {
        const count = h.nodeCount(); const reqs: Array<[number, number, number]> = [];
        for (let hd = 0; hd < count; hd++) {
            const { id, depth } = h.decode(hd); if (depth < 3 || depth >= D) continue;
            const t = lebDecode(id, depth); const c = norm(add(add(t[0], t[1]), t[2]));
            const dist = Math.hypot(c[0] - P[0], c[1] - P[1], c[2] - P[2]);
            const want = 3 + Math.min(maxExtra, Math.floor(0.9 / (dist + 0.06)));
            if (depth < want) { const ld = depth - 3; reqs.push([(id >> ld) - 8, (1 << ld) | (id & ((1 << ld) - 1)), ld]); }
        }
        if (!reqs.length) break;
        for (const [f, id, d] of reqs) { splitConforming(h, f, id, d, D); if (mode === 'sequential') h.sumReduce(); }
        if (mode === 'batch') h.sumReduce();
    }
    return tjCheck(h);
}

describe('Phase 3b conforming split (Dupuy convention, CPU isolation)', () => {
    it('field .edge shares the split edge (v0,v2)', () => {
        let edgeShares = 0, checked = 0;
        for (let d = 1; d <= 6; d++) for (let id = (1 << d); id < (2 << d); id++) {
            const e = neighbors(id, d).edge; if (e === 0) continue; checked++;
            const [v0, , v2] = lebDecode(localToFull(0, id, d), d + 3);
            const [na, nl, nr] = lebDecode(localToFull(0, e, d), d + 3);
            const nbE = new Set([ek(na, nl), ek(nl, nr), ek(nr, na)]);
            if (nbE.has(ek(v0, v2))) edgeShares++;
        }
        // eslint-disable-next-line no-console
        console.log('edge shares split(v0,v2):', edgeShares, '/', checked);
        expect(edgeShares).toBe(checked);
    });
    it('sequential refine watertight within faces', () => {
        const r = refine('sequential', 14, 9); // eslint-disable-next-line no-console
        console.log('SEQUENTIAL', r); expect(r.interior).toBe(0);
    });
    it('batch (GPU-like) refine watertight within faces', () => {
        const r = refine('batch', 14, 9); // eslint-disable-next-line no-console
        console.log('BATCH', r); expect(r.interior).toBe(0);
    });
});
