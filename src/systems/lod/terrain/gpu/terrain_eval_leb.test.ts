import { describe, expect, it } from 'vitest';
import { GPU_FACE_CORNERS, terrainCorners, terrainFaceOf, type V3 } from './terrain_eval_leb';

const TOL = 1e-9;

function eq(a: V3, b: V3): boolean {
    return (
        Math.abs(a[0] - b[0]) < TOL &&
        Math.abs(a[1] - b[1]) < TOL &&
        Math.abs(a[2] - b[2]) < TOL
    );
}

function unit(p: V3): boolean {
    return Math.abs(Math.hypot(p[0], p[1], p[2]) - 1) < TOL;
}

/** Number of shared corners between two triangles (full edge => 2). */
function sharedCorners(t: [V3, V3, V3], u: [V3, V3, V3]): number {
    let n = 0;
    for (const p of t) for (const q of u) if (eq(p, q)) { n++; break; }
    return n;
}

describe('terrainFaceOf', () => {
    it('maps the 8 root heap ids (8..15) to faces 0..7 at depth 3', () => {
        for (let f = 0; f < 8; f++) expect(terrainFaceOf(8 + f, 3)).toBe(f);
    });
    it('is convention-invariant (top bits) for deeper ids', () => {
        // heapID 16,17 are children of face 0 (heap 8) at depth 4.
        expect(terrainFaceOf(16, 4)).toBe(0);
        expect(terrainFaceOf(17, 4)).toBe(0);
        // heapID 9 -> face 1; its L1 children 18,19 stay on face 1.
        expect(terrainFaceOf(18, 4)).toBe(1);
        expect(terrainFaceOf(19, 4)).toBe(1);
    });
});

describe('terrainCorners (reference convention) — seed', () => {
    it('decodes each root face to its (right, apex, left) seed', () => {
        for (let f = 0; f < 8; f++) {
            const fc = GPU_FACE_CORNERS[f];
            const [v0, v1, v2] = terrainCorners(8 + f);
            expect(eq(v0, fc.r as V3)).toBe(true); // v0 = right
            expect(eq(v1, fc.a as V3)).toBe(true); // v1 = apex
            expect(eq(v2, fc.l as V3)).toBe(true); // v2 = left
        }
    });
});

describe('terrainCorners — first bisection of face 0', () => {
    const SQRT1_2 = Math.SQRT1_2;
    const mid: V3 = [SQRT1_2, 0, SQRT1_2]; // normalize(right + left) = normalize([1,0,1])

    it('child 16 (path bit 0) = (left, mid, apex)', () => {
        const [v0, v1, v2] = terrainCorners(16);
        expect(eq(v0, [0, 0, 1])).toBe(true); // old left
        expect(eq(v1, mid)).toBe(true);
        expect(eq(v2, [0, 1, 0])).toBe(true); // old apex
    });
    it('child 17 (path bit 1) = (apex, mid, right)', () => {
        const [v0, v1, v2] = terrainCorners(17);
        expect(eq(v0, [0, 1, 0])).toBe(true); // old apex
        expect(eq(v1, mid)).toBe(true);
        expect(eq(v2, [1, 0, 0])).toBe(true); // old right
    });
    it('the two children share a full edge (watertight sibling split)', () => {
        expect(sharedCorners(terrainCorners(16), terrainCorners(17))).toBe(2);
    });
});

describe('terrainCorners — invariants over a uniform L3 refinement of face 0', () => {
    it('all corners are unit-length', () => {
        // Face 0 at depth 6 (level 3): heap ids 8*8 .. 8*8+7 -> 64..71.
        for (let h = 64; h < 72; h++) {
            const tri = terrainCorners(h);
            for (const c of tri) expect(unit(c)).toBe(true);
        }
    });
    it('consecutive sibling leaves share a full edge', () => {
        // Even/odd pairs (h, h+1) are bisection siblings and must share an edge.
        for (let h = 64; h < 72; h += 2) {
            expect(sharedCorners(terrainCorners(h), terrainCorners(h + 1))).toBe(2);
        }
    });
});
