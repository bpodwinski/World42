/**
 * CPU mirror of cbt_leb.wgsl — octahedron face corners + longest-edge-bisection
 * decode. Used to validate the GPU decode (f64 here vs f32 on the GPU, so compare
 * with a small tolerance). The subdivision rule matches CbtState.subdivide:
 * VC = normalize(L+R); child0 = (VC, A, L); child1 = (VC, R, A); faces 0..7 are the
 * depth-3 nodes (ids 8..15).
 */

export type Vec3 = [number, number, number];
export type LebTri = { a: Vec3; l: Vec3; r: Vec3 };

// Octahedron faces (apex, left, right), mirror of ROOT_ALR + VX in cbt_state.ts.
const FACES: LebTri[] = [
    { a: [0, 1, 0], l: [1, 0, 0], r: [0, 0, 1] },
    { a: [0, 1, 0], l: [0, 0, 1], r: [-1, 0, 0] },
    { a: [0, 1, 0], l: [-1, 0, 0], r: [0, 0, -1] },
    { a: [0, 1, 0], l: [0, 0, -1], r: [1, 0, 0] },
    { a: [0, -1, 0], l: [1, 0, 0], r: [0, 0, 1] },
    { a: [0, -1, 0], l: [0, 0, 1], r: [-1, 0, 0] },
    { a: [0, -1, 0], l: [-1, 0, 0], r: [0, 0, -1] },
    { a: [0, -1, 0], l: [0, 0, -1], r: [1, 0, 0] },
];

function normalize(v: Vec3): Vec3 {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    const s = len > 1e-20 ? 1 / len : 0;
    return [v[0] * s, v[1] * s, v[2] * s];
}

/** Decode a heap node (id, depth >= 3) to its leaf triangle's 3 unit corners. */
export function lebDecodeUnit(id: number, depth: number): LebTri {
    const face = (id >> (depth - 3)) - 8;
    let { a, l, r } = FACES[face];
    const steps = depth - 3;
    for (let s = 0; s < steps; s++) {
        const bitpos = steps - 1 - s;
        const bit = (id >> bitpos) & 1;
        const vc = normalize([l[0] + r[0], l[1] + r[1], l[2] + r[2]]);
        if (bit === 0) {
            // child0 = (VC, A, L)
            [a, l, r] = [vc, a, l];
        } else {
            // child1 = (VC, R, A)
            [a, l, r] = [vc, r, a];
        }
    }
    return { a, l, r };
}
