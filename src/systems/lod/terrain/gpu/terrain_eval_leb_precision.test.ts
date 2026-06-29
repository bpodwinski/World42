// Precision guard for the §4.1 planar (closed-form barycentric) decode: it must stay
// far below the leaf-edge size at every depth through 60 (cm leaves on a 6371 km
// sphere). This locks in the key property that the planar decode is essentially
// DEPTH-INDEPENDENT in precision (the recursive-slerp decode it replaced accumulated
// error per normalize and cracked ~depth 45). Reference is native JS f64 (~52 bit) vs
// the df64 (~48 bit) decode mirror of the WGSL render path; their difference reveals the
// df64 error. If a future change reintroduces per-step normalization this regresses.
import { describe, it, expect } from 'vitest';
import {
    df64FromNumber,
    df64ToNumber,
    df64Add,
    df64MulF32,
    df64Mul,
    df64InvSqrt,
    type DF64
} from './terrain_f64';

type V = [DF64, DF64, DF64];
const RKM = 6371;

const vFrom = (x: number, y: number, z: number): V => [
    df64FromNumber(x),
    df64FromNumber(y),
    df64FromNumber(z)
];
const vAdd = (a: V, b: V): V => [df64Add(a[0], b[0]), df64Add(a[1], b[1]), df64Add(a[2], b[2])];
const vScale = (a: V, s: number): V => [df64MulF32(a[0], s), df64MulF32(a[1], s), df64MulF32(a[2], s)];
const vNorm = (a: V): V => {
    const l2 = df64Add(df64Add(df64Mul(a[0], a[0]), df64Mul(a[1], a[1])), df64Mul(a[2], a[2]));
    const inv = df64InvSqrt(l2);
    return [df64Mul(a[0], inv), df64Mul(a[1], inv), df64Mul(a[2], inv)];
};

// Planar decode of face 0 (seed v0=r,v1=a,v2=l), MSB->LSB path bits, single final
// normalize — the df64 twin of terrain_topo_eval_leb_f64.compute.wgsl, returning corner v0.
function decodeDf(pathBits: number[]): [number, number, number] {
    let v0 = vFrom(1, 0, 0);
    let v1 = vFrom(0, 1, 0);
    let v2 = vFrom(0, 0, 1);
    for (const bit of pathBits) {
        const m = vScale(vAdd(v0, v2), 0.5);
        if (bit === 0) {
            const nv0 = v2;
            v2 = v1;
            v0 = nv0;
            v1 = m;
        } else {
            const nv0 = v1;
            const nv2 = v0;
            v0 = nv0;
            v1 = m;
            v2 = nv2;
        }
    }
    v0 = vNorm(v0);
    return [df64ToNumber(v0[0]), df64ToNumber(v0[1]), df64ToNumber(v0[2])];
}

function decodeF64(pathBits: number[]): [number, number, number] {
    let v0 = [1, 0, 0];
    let v1 = [0, 1, 0];
    let v2 = [0, 0, 1];
    for (const bit of pathBits) {
        const m = [(v0[0] + v2[0]) * 0.5, (v0[1] + v2[1]) * 0.5, (v0[2] + v2[2]) * 0.5];
        if (bit === 0) {
            const nv0 = v2;
            v2 = v1;
            v0 = nv0;
            v1 = m;
        } else {
            const nv0 = v1;
            const nv2 = v0;
            v0 = nv0;
            v1 = m;
            v2 = nv2;
        }
    }
    const il = 1 / Math.hypot(v0[0], v0[1], v0[2]);
    return [v0[0] * il, v0[1] * il, v0[2] * il];
}

const mkPath = (steps: number): number[] => {
    const p: number[] = [];
    let s = 0x9e3779b9 >>> 0;
    for (let i = 0; i < steps; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        p.push((s >>> 16) & 1);
    }
    return p;
};

describe('terrain df64 planar decode — precision stays far below leaf edge through depth 60', () => {
    it('df64 decode error is < 1e-3 of the leaf edge at every depth (cm-capable, slerp-free)', () => {
        for (const depth of [20, 30, 40, 45, 50, 55, 60]) {
            const path = mkPath(depth - 3);
            const a = decodeDf(path);
            const b = decodeF64(path);
            const errKm = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * RKM;
            const edgeKm = (RKM * Math.SQRT2) / Math.pow(2, depth / 2);
            expect(errKm / edgeKm, `depth ${depth}: err/edge`).toBeLessThan(1e-3);
        }
    });
});
