/**
 * Phase 3b-ii experiment: cross-face (octahedron seam) conforming split, validated
 * in CPU before porting to WGSL. Uses a geometric split-edge neighbor (decode the
 * seam edge, encode the matching node in the adjacent face) + recursive Rivara
 * forced split. Goal: a metric-driven split-only refinement with ZERO T-junctions
 * (interior AND seam).
 */
import { describe, it, expect } from 'vitest';
import { CbtCpuHeap } from './gpu_cbt_buffers';

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Face corners (apex=pole, L, R); equatorial hypotenuse = (L,R).
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
// Dupuy convention (v0=L, v1=apex, v2=R), split edge (v0,v2).
function lebTri(face: number, localId: number, localDepth: number): [V3, V3, V3] {
    const fc = FACE_ALR[face];
    let v0: V3 = fc[1], v1: V3 = fc[0], v2: V3 = fc[2];
    for (let k = 0; k < localDepth; k++) {
        const bit = (localId >> (localDepth - 1 - k)) & 1;
        const m = norm(add(v0, v2));
        const ov1 = v1;
        if (bit === 0) { v1 = m; v2 = ov1; } else { v0 = ov1; v1 = m; }
    }
    return [v0, v1, v2];
}
function edgeNeighborLocal(localId: number, localDepth: number): number {
    let nLeft = 0, nRight = 0, nEdge = 0, nNode = 1;
    for (let bit = localDepth - 1; bit >= 0; bit--) {
        const sb = (localId >> bit) & 1;
        const n1 = nLeft, n2 = nRight, n3 = nEdge, n4 = nNode;
        const b2 = n2 !== 0 ? 1 : 0, b3 = n3 !== 0 ? 1 : 0;
        if (sb === 0) { nLeft = (n4 << 1) | 1; nRight = (n3 << 1) | b3; nEdge = (n2 << 1) | b2; nNode = n4 << 1; }
        else { nLeft = n3 << 1; nRight = n4 << 1; nEdge = n1 << 1; nNode = (n4 << 1) | 1; }
    }
    return nEdge;
}
const localToFull = (f: number, id: number, d: number): number => ((8 + f) << d) | (id & ((1 << d) - 1));
const faceOf = (fullId: number, depth: number): number => (fullId >> (depth - 3)) - 8;
const localIdOf = (fullId: number, depth: number): number => { const d = depth - 3; return (1 << d) | (fullId & ((1 << d) - 1)); };

// --- octahedron seam topology -------------------------------------------------
const AXIS: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const axisIndex = (v: V3): number => { let bi = 0, bd = -2; for (let i = 0; i < 6; i++) { const d = dot(v, AXIS[i]); if (d > bd) { bd = d; bi = i; } } return bi; };
// faces touching each axis-vertex pair (octahedron edge) -> list of faces.
function faceContains(face: number, ai: number): boolean { return FACE_ALR[face].some((v) => axisIndex(v) === ai); }
function adjacentFace(face: number, P: V3, Q: V3): number {
    // The seam edge lies in a coordinate plane (one coord ~ 0); the other two coord
    // signs of the midpoint pick the two axis vertices it connects. (Using each
    // endpoint's nearest axis fails for short sub-edges near one vertex.)
    const m = norm(add(P, Q));
    let zc = 0; for (let i = 1; i < 3; i++) if (Math.abs(m[i]) < Math.abs(m[zc])) zc = i;
    const verts: number[] = [];
    for (let j = 0; j < 3; j++) if (j !== zc) verts.push(2 * j + (m[j] > 0 ? 0 : 1)); // AXIS index
    const [a, b] = verts;
    for (let f = 0; f < 8; f++) { if (f !== face && faceContains(f, a) && faceContains(f, b)) return f; }
    return -1;
}
// penalty for x being outside spherical triangle (a,b,c); 0 if inside (closed).
function outPenalty(x: V3, a: V3, b: V3, c: V3): number {
    let p = 0;
    const edges: [V3, V3, V3][] = [[a, b, c], [b, c, a], [c, a, b]];
    for (const [e1, e2, opp] of edges) {
        const n = cross(e1, e2);
        let s = dot(x, n); const r = dot(opp, n);
        if (r < 0) s = -s;
        if (s < -1e-7) p += -s;
    }
    return p;
}
// Encode the node in faceB at localDepth d whose split edge == {P,Q}.
function encodeByEdge(faceB: number, P: V3, Q: V3, d: number): number {
    const fc = FACE_ALR[faceB];
    let v0: V3 = fc[1], v1: V3 = fc[0], v2: V3 = fc[2];
    let lid = 1;
    for (let k = 0; k < d; k++) {
        const m = norm(add(v0, v2));
        const c0: [V3, V3, V3] = [v0, m, v1];
        const c1: [V3, V3, V3] = [v1, m, v2];
        const p0 = outPenalty(P, ...c0) + outPenalty(Q, ...c0);
        const p1 = outPenalty(P, ...c1) + outPenalty(Q, ...c1);
        if (p0 <= p1) { v0 = c0[0]; v1 = c0[1]; v2 = c0[2]; lid = lid << 1; }
        else { v0 = c1[0]; v1 = c1[1]; v2 = c1[2]; lid = (lid << 1) | 1; }
    }
    return lid;
}
// Cross-face split-edge neighbor: returns {face, localId} at the same localDepth, or null.
function crossEdge(face: number, localId: number, localDepth: number): { face: number; localId: number } | null {
    const e = edgeNeighborLocal(localId, localDepth);
    if (e !== 0) return { face, localId: e };
    const [v0, , v2] = lebTri(face, localId, localDepth); // split edge (v0,v2)
    const fB = adjacentFace(face, v0, v2);
    if (fB < 0) return null;
    return { face: fB, localId: encodeByEdge(fB, v0, v2, localDepth) };
}

// --- pure cross-face conforming chain (Dupuy, no heap reads => GPU-friendly) ---
function bisectFace(h: CbtCpuHeap, cf: number, clid: number, cld: number): void {
    const full = localToFull(cf, clid, cld);
    h.setBit(h.bfIndex((full << 1) | 1, cld + 3 + 1), 1);
}
// Conforming split of (face0, lid0, ld0): bisect it, then walk the longest-edge
// compatibility chain (cross-face) bisecting node + parent at each step. Pure id +
// geometry math, NO heap reads, so a batch of these applied to a stale snapshot
// (then reduced once) converges to a watertight tree — matching the GPU pass.
function splitCF(h: CbtCpuHeap, face0: number, lid0: number, ld0: number, D: number): void {
    if (ld0 + 3 >= D) return; // ceil
    bisectFace(h, face0, lid0, ld0);
    let nb = crossEdge(face0, lid0, ld0);
    if (!nb) return;
    let cf = nb.face, clid = nb.localId, cld = ld0;
    for (let i = 0; i < 6 * D; i++) {
        bisectFace(h, cf, clid, cld);
        if (cld === 0) { // face root: couple the equatorial base diamond, then stop
            const pr = crossEdge(cf, clid, cld);
            if (pr) bisectFace(h, pr.face, pr.localId, 0);
            return;
        }
        clid = clid >> 1; cld = cld - 1; // parent (same face)
        bisectFace(h, cf, clid, cld);
        if (cld === 0) {
            const pr = crossEdge(cf, clid, cld);
            if (pr) bisectFace(h, pr.face, pr.localId, 0);
            return;
        }
        nb = crossEdge(cf, clid, cld); // parent's edge neighbor (same depth)
        if (!nb) return;
        cf = nb.face; clid = nb.localId;
    }
}

// --- T-junction check ---------------------------------------------------------
const Q = 1e5;
const vk = (v: V3) => `${Math.round(v[0] * Q)},${Math.round(v[1] * Q)},${Math.round(v[2] * Q)}`;
function tjCheck(h: CbtCpuHeap) {
    const count = h.nodeCount();
    const verts = new Set<string>(); const leaves: Array<[V3, V3, V3]> = [];
    for (let hd = 0; hd < count; hd++) {
        const { id, depth } = h.decode(hd); if (depth < 3) continue;
        const t = lebTri(faceOf(id, depth), localIdOf(id, depth), depth - 3);
        leaves.push(t); for (const v of t) verts.add(vk(v));
    }
    let total = 0, interior = 0, seam = 0;
    const ce = (a: V3, b: V3) => { const m = norm(add(a, b)); if (verts.has(vk(m))) { total++; if (Math.min(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2])) < 1e-4) seam++; else interior++; } };
    for (const [a, l, r] of leaves) { ce(a, l); ce(l, r); ce(r, a); }
    return { total, interior, seam, leaves: leaves.length };
}

// Batch driver (= GPU pass): each iteration classifies the stale snapshot, applies
// every conforming split, then reduces once.
function refine(D: number, maxExtra: number, P: V3) {
    const h = new CbtCpuHeap(D); h.seedLevel(3); h.sumReduce();
    for (let iter = 0; iter < 80; iter++) {
        const count = h.nodeCount(); const reqs: Array<[number, number, number]> = [];
        for (let hd = 0; hd < count; hd++) {
            const { id, depth } = h.decode(hd); if (depth < 3 || depth >= D) continue;
            const t = lebTri(faceOf(id, depth), localIdOf(id, depth), depth - 3);
            const c = norm(add(add(t[0], t[1]), t[2]));
            const dist = Math.hypot(c[0] - P[0], c[1] - P[1], c[2] - P[2]);
            const want = 3 + Math.min(maxExtra, Math.floor(2.0 / (dist + 0.05)));
            if (depth < want) reqs.push([faceOf(id, depth), localIdOf(id, depth), depth - 3]);
        }
        if (!reqs.length) break;
        for (const [f, lid, ld] of reqs) splitCF(h, f, lid, ld, D);
        h.sumReduce();
    }
    return tjCheck(h);
}

describe('Phase 3b-ii cross-face conforming split (CPU)', () => {
    it('encode/decode round-trip across a seam preserves the edge', () => {
        // node on face 0 whose split edge is on a seam -> neighbor in another face
        let crossed = 0, ok = 0;
        for (let ld = 1; ld <= 5; ld++) for (let lid = (1 << ld); lid < (2 << ld); lid++) {
            if (edgeNeighborLocal(lid, ld) !== 0) continue; // intra-face
            const [v0, , v2] = lebTri(0, lid, ld);
            const nb = crossEdge(0, lid, ld); if (!nb) continue; crossed++;
            const [nv0, , nv2] = lebTri(nb.face, nb.localId, ld);
            const same = new Set([vk(v0), vk(v2)]);
            if (same.has(vk(nv0)) && same.has(vk(nv2))) ok++;
        }
        // eslint-disable-next-line no-console
        console.log('seam neighbors:', { crossed, edgeMatched: ok });
        expect(ok).toBe(crossed);
        expect(crossed).toBeGreaterThan(0);
    });
    it('refinement is fully watertight (interior=0 AND seam=0) at a face-interior point', () => {
        const r = refine(13, 8, norm([0.37, 0.62, 0.55]));
        // eslint-disable-next-line no-console
        console.log('INTERIOR-PT', r);
        expect(r.interior).toBe(0);
        expect(r.seam).toBe(0);
    });
    it('refinement is fully watertight at a point ON a seam (stress)', () => {
        const r = refine(13, 8, norm([1, 0, 1])); // on the +x/+z equatorial seam
        // eslint-disable-next-line no-console
        console.log('SEAM-PT', r);
        expect(r.interior).toBe(0);
        expect(r.seam).toBe(0);
    });
});
