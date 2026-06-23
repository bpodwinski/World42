import { describe, it, expect } from 'vitest';
import { lebDecode, lebDepth, lebFaceCorners, type LebTri } from './ocbt_leb';

const close = (a: number, b: number, eps = 1e-12) => Math.abs(a - b) <= eps;
function vEq(a: readonly number[], b: readonly number[], eps = 1e-12): boolean {
    return close(a[0], b[0], eps) && close(a[1], b[1], eps) && close(a[2], b[2], eps);
}
function isUnit(v: readonly number[]): boolean {
    return close(Math.hypot(v[0], v[1], v[2]), 1);
}
function normalize(x: number, y: number, z: number): [number, number, number] {
    const i = 1 / Math.hypot(x, y, z);
    return [x * i, y * i, z * i];
}

describe('ocbt_leb — depth', () => {
    it('face nodes 8..15 are depth 3; children grow by one', () => {
        expect(lebDepth(8)).toBe(3);
        expect(lebDepth(15)).toBe(3);
        expect(lebDepth(16)).toBe(4);
        expect(lebDepth(31)).toBe(4);
        expect(lebDepth(32)).toBe(5);
        // exact at powers of two (no log2 rounding)
        for (let d = 3; d <= 40; d++) expect(lebDepth(2 ** d)).toBe(d);
    });
});

describe('ocbt_leb — face decode', () => {
    it('depth-3 decode returns the face corners verbatim', () => {
        for (let face = 0; face < 8; face++) {
            const heapID = 8 + face;
            const got = lebDecode(heapID, 3);
            const fc = lebFaceCorners(face);
            expect(vEq(got.a, fc.a)).toBe(true);
            expect(vEq(got.l, fc.l)).toBe(true);
            expect(vEq(got.r, fc.r)).toBe(true);
        }
    });
});

describe('ocbt_leb — one bisection', () => {
    it('the two children of a face share the split-edge midpoint as apex and tile the parent', () => {
        const face = 0;
        const parent = lebDecode(8 + face, 3); // a=(0,1,0) l=(1,0,0) r=(0,0,1)
        const mid = normalize(
            parent.l[0] + parent.r[0],
            parent.l[1] + parent.r[1],
            parent.l[2] + parent.r[2]
        );
        const c0 = lebDecode((8 + face) * 2, 4); // path bit 0
        const c1 = lebDecode((8 + face) * 2 + 1, 4); // path bit 1

        // Both children's apex is the split-edge midpoint.
        expect(vEq(c0.a, mid)).toBe(true);
        expect(vEq(c1.a, mid)).toBe(true);
        // child0 keeps parent.left; child1 keeps parent.right.
        expect(vEq(c0.l, parent.l)).toBe(true);
        expect(vEq(c1.r, parent.r)).toBe(true);
        // The internal shared vertex is the parent's apex.
        expect(vEq(c0.r, parent.a)).toBe(true);
        expect(vEq(c1.l, parent.a)).toBe(true);
        // All corners stay on the unit sphere.
        for (const v of [c0.a, c0.l, c0.r, c1.a, c1.l, c1.r]) expect(isUnit(v)).toBe(true);
    });
});

describe('ocbt_leb — recursive subdivision is watertight within a face', () => {
    // Geometric reference: decode by walking the split tree with on-sphere midpoints.
    function refDecode(heapID: number, depth: number): LebTri {
        const face = (heapID >>> (depth - 3)) - 8;
        const fc = lebFaceCorners(face);
        let v0 = fc.l;
        let v1 = fc.a;
        let v2 = fc.r;
        for (let s = 0; s < depth - 3; s++) {
            const bit = (heapID >>> (depth - 3 - 1 - s)) & 1;
            const m = normalize(v0[0] + v2[0], v0[1] + v2[1], v0[2] + v2[2]);
            const ov1 = v1;
            if (bit === 0) {
                v1 = m;
                v2 = ov1;
            } else {
                v0 = ov1;
                v1 = m;
            }
        }
        return { a: v1, l: v0, r: v2 };
    }

    it('a parent equals the union of its two children edges at several depths', () => {
        for (const depth of [4, 6, 8]) {
            const base = (8 + 3) << (depth - 3); // face 3, leftmost path
            for (let k = 0; k < 8; k++) {
                const id = base + k;
                const tri = lebDecode(id, depth);
                const ref = refDecode(id, depth);
                expect(vEq(tri.a, ref.a)).toBe(true);
                expect(vEq(tri.l, ref.l)).toBe(true);
                expect(vEq(tri.r, ref.r)).toBe(true);
                // children of `id` share its split-edge midpoint
                const mid = normalize(tri.l[0] + tri.r[0], tri.l[1] + tri.r[1], tri.l[2] + tri.r[2]);
                const a0 = lebDecode(id * 2, depth + 1);
                const a1 = lebDecode(id * 2 + 1, depth + 1);
                expect(vEq(a0.a, mid)).toBe(true);
                expect(vEq(a1.a, mid)).toBe(true);
            }
        }
    });
});
