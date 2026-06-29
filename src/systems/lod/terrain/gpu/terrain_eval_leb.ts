/**
 * TERRAIN vertex decode — REFERENCE leb convention over the consistently-wound
 * octahedron. This is the convention the GPU concurrent topology engine actually
 * stores heap ids in (see terrain_engine_buffers.ts: the seed is reoriented so every
 * shared edge is traversed in opposite directions by its two faces, as the ported
 * `evaluate_neighbors` requires). It is DISTINCT from World42's legacy `terrain_leb.ts`
 * / `terrain_leb.wgsl` convention (lebFaceCorners + v0=left seed), which the implicit
 * TERRAIN path uses — the two differ by a geometry-dependent per-level bit swap, so the
 * TERRAIN render path MUST decode with THIS module, never the legacy one.
 *
 * This is the proven decoder extracted verbatim from the Phase 1c cross-check
 * (`terrain_topology_gpu_test_main.ts`, where it validated 10/10 against the CPU oracle
 * by geometry). The WGSL twin (`terrain_eval_leb.wgsl`) mirrors it bit-for-bit and is
 * itself GPU-cross-checked against this TS.
 *
 * heapID is a JS number here (exact for depth < 53); the GPU carries it as u64
 * (`terrain_u64`). Decode is the closed-form barycentric matrix (planar), projected once.
 */
import { lebDepth } from './terrain_leb';

export type V3 = [number, number, number];

function norm(x: number, y: number, z: number): V3 {
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    return [x * inv, y * inv, z * inv];
}

type Mat3 = readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
];

const IDENTITY3: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
];

/**
 * Per-bit LEB splitting matrices (reference leb.hlsl `leb__SplittingMatrix`, exact
 * {0, 0.5, 1}). bit0 keeps the parent's {apex, left} (child 2h); bit1 keeps {apex,
 * right} (child 2h+1) — the invariant the TERRAIN topology relies on for integer labeling.
 */
const SPLIT: readonly [Mat3, Mat3] = [
    [
        [0, 0, 1],
        [0.5, 0, 0.5],
        [0, 1, 0]
    ],
    [
        [0, 1, 0],
        [0.5, 0, 0.5],
        [1, 0, 0]
    ]
];

/** Standard 3x3 product a·b (row-major). */
function mat3Mul(a: Mat3, b: Mat3): Mat3 {
    const r: number[][] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
    ];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    return r as unknown as Mat3;
}

/**
 * Consistently-wound octahedron face corners {apex, left, right}. Matches the GPU
 * seed adjacency in terrain_engine_buffers (top faces 0..3 have l/r swapped vs the
 * legacy lebFaceCorners; bottom faces 4..7 identical), so every shared edge is
 * traversed in opposite directions by its two faces — the orientation the reference
 * engine's neighbor logic assumes.
 */
export const GPU_FACE_CORNERS: ReadonlyArray<{ a: V3; l: V3; r: V3 }> = [
    { a: [0, 1, 0], l: [0, 0, 1], r: [1, 0, 0] },
    { a: [0, 1, 0], l: [-1, 0, 0], r: [0, 0, 1] },
    { a: [0, 1, 0], l: [0, 0, -1], r: [-1, 0, 0] },
    { a: [0, 1, 0], l: [1, 0, 0], r: [0, 0, -1] },
    { a: [0, -1, 0], l: [1, 0, 0], r: [0, 0, 1] },
    { a: [0, -1, 0], l: [0, 0, 1], r: [-1, 0, 0] },
    { a: [0, -1, 0], l: [-1, 0, 0], r: [0, 0, -1] },
    { a: [0, -1, 0], l: [0, 0, -1], r: [1, 0, 0] }
];

/** Octahedron face index (0..7) of a heap id at the given depth. */
export function terrainFaceOf(heapID: number, depth: number): number {
    return Math.floor(heapID / Math.pow(2, depth - 3)) - 8;
}

/**
 * Decode a heap id to its three unit-sphere corners (v0, v1, v2) in the REFERENCE
 * leb convention, via the CLOSED-FORM barycentric matrix (Dupuy large_terrain:
 * leb__SplittingMatrix + leb_DecodeNodeAttributeArray). Build W = product of the
 * per-bit split matrices over the `steps = depth-3` path bits (MSB->LSB, each split
 * left-multiplied); then each leaf corner is the barycentric combination
 * `leaf_i = Σ_j W[i][j]·seed_j` of the face seed, normalized to the sphere EXACTLY
 * ONCE. This is planar-then-projected, NOT recursive slerp (no per-step normalize):
 * bit-identical to slerp through depth 4 (a single midpoint of two unit corners IS its
 * own great-circle midpoint), micro-divergent beyond. The bounded form (matrix + one
 * projection) is the structure the cm precision path (triple-single) attaches to —
 * recursive slerp has no closed form.
 *
 * CRITICAL seed: v0=right, v1=apex, v2=left over GPU_FACE_CORNERS.
 */
export function terrainCorners(heapID: number): [V3, V3, V3] {
    const depth = lebDepth(heapID);
    const face = terrainFaceOf(heapID, depth);
    const fc = GPU_FACE_CORNERS[face];
    const seed: readonly [V3, V3, V3] = [fc.r, fc.a, fc.l]; // (v0,v1,v2) = (right, apex, left)
    const steps = depth - 3;

    // W = Π split(bit) over the path bits, MSB first, each split left-multiplied.
    let w: Mat3 = IDENTITY3;
    for (let s = 0; s < steps; s++) {
        const bit = Math.floor(heapID / Math.pow(2, steps - 1 - s)) % 2;
        w = mat3Mul(SPLIT[bit], w);
    }

    // leaf_i = Σ_j W[i][j]·seed_j, projected to the sphere once.
    const out: V3[] = [];
    for (let i = 0; i < 3; i++) {
        const wi = w[i];
        out.push(
            norm(
                wi[0] * seed[0][0] + wi[1] * seed[1][0] + wi[2] * seed[2][0],
                wi[0] * seed[0][1] + wi[1] * seed[1][1] + wi[2] * seed[2][1],
                wi[0] * seed[0][2] + wi[1] * seed[1][2] + wi[2] * seed[2][2]
            )
        );
    }
    return [out[0], out[1], out[2]];
}
