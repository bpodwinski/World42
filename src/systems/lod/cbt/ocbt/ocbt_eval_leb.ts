/**
 * OCBT vertex decode — REFERENCE leb convention over the consistently-wound
 * octahedron. This is the convention the GPU concurrent topology engine actually
 * stores heap ids in (see ocbt_engine_buffers.ts: the seed is reoriented so every
 * shared edge is traversed in opposite directions by its two faces, as the ported
 * `evaluate_neighbors` requires). It is DISTINCT from World42's legacy `ocbt_leb.ts`
 * / `cbt_leb.wgsl` convention (lebFaceCorners + v0=left seed), which the implicit
 * CBT path uses — the two differ by a geometry-dependent per-level bit swap, so the
 * OCBT render path MUST decode with THIS module, never the legacy one.
 *
 * This is the proven decoder extracted verbatim from the Phase 1c cross-check
 * (`ocbt_topology_gpu_test_main.ts`, where it validated 10/10 against the CPU oracle
 * by geometry). The WGSL twin (`ocbt_eval_leb.wgsl`) mirrors it bit-for-bit and is
 * itself GPU-cross-checked against this TS.
 *
 * heapID is a JS number here (exact for depth < 53); the GPU carries it as u64
 * (`ocbt_u64`). Spherical: the split-edge midpoint is normalized every step.
 */
import { lebDepth } from './ocbt_leb';

export type V3 = [number, number, number];

function norm(x: number, y: number, z: number): V3 {
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    return [x * inv, y * inv, z * inv];
}

/**
 * Consistently-wound octahedron face corners {apex, left, right}. Matches the GPU
 * seed adjacency in ocbt_engine_buffers (top faces 0..3 have l/r swapped vs the
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
export function ocbtFaceOf(heapID: number, depth: number): number {
    return Math.floor(heapID / Math.pow(2, depth - 3)) - 8;
}

/**
 * Decode a heap id to its three unit-sphere corners (v0, v1, v2) in the REFERENCE
 * leb convention. Mirrors leb.hlsl's splitting matrix (bit0: v0'=v2, v1'=mid(v0,v2),
 * v2'=v1; bit1: v0'=v1, v1'=mid, v2'=v0) with the midpoint normalized each step.
 * CRITICAL seed: v0=right, v1=apex, v2=left over GPU_FACE_CORNERS — the orientation
 * that makes the per-bit rule consistent with the seed's neighbor lanes.
 */
export function ocbtCorners(heapID: number): [V3, V3, V3] {
    const depth = lebDepth(heapID);
    const face = ocbtFaceOf(heapID, depth);
    const fc = GPU_FACE_CORNERS[face];
    let v0: V3 = [...fc.r] as V3;
    let v1: V3 = [...fc.a] as V3;
    let v2: V3 = [...fc.l] as V3;
    const steps = depth - 3;
    for (let s = 0; s < steps; s++) {
        const bit = Math.floor(heapID / Math.pow(2, steps - 1 - s)) % 2;
        const m = norm(v0[0] + v2[0], v0[1] + v2[1], v0[2] + v2[2]);
        if (bit === 0) {
            const nv0 = v2; // v0'=v2
            v2 = v1; // v2'=v1
            v0 = nv0;
            v1 = m;
        } else {
            const nv0 = v1; // v0'=v1
            const nv2 = v0; // v2'=v0
            v0 = nv0;
            v1 = m;
            v2 = nv2;
        }
    }
    return [v0, v1, v2];
}
