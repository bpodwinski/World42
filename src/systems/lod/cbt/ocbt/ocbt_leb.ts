/**
 * Longest-edge-bisection vertex decode for the OCBT path — the TS mirror of
 * `src/assets/shaders/cbt/gpu/cbt_leb.wgsl` (and the future `ocbt_eval_leb`). Given a
 * heap id and its depth, returns the leaf triangle's three corners as unit
 * directions on the sphere (caller scales by radius + adds displacement).
 *
 * Convention (must match cbt_leb.wgsl exactly so OCBT topology, vertex decode, and
 * the existing implicit-CBT path all agree): the 8 octahedron faces are the depth-3
 * heap nodes 8..15. A node at full `depth` has heapID with its MSB at bit `depth`
 * (face = `id >> (depth-3)` gives 8..15). Decode seeds (v0,v1,v2) = (face.left,
 * face.apex, face.right) — split edge is the hypotenuse (v0,v2), apex is the middle
 * v1 — then applies (depth-3) bisections MSB-first: m = normalize(v0+v2); bit 0 ->
 * child (v0, m, v1_old); bit 1 -> child (v1_old, m, v2). Returns (v0, v1, v2).
 *
 * heapID is a JS number here (exact for depth < 53, which covers Phase 1 tests); the
 * GPU uses the u64 emulation (`ocbt_u64`). depth() mirrors firstbithigh+.. = the bit
 * length minus one.
 */

/** A unit-sphere triangle: a = apex (middle), l = left, r = right (split edge = l..r). */
export interface LebTri {
    a: [number, number, number];
    l: [number, number, number];
    r: [number, number, number];
}

/**
 * Tree depth of a heap id = floor(log2(heapID)) (face nodes 8..15 -> depth 3).
 * Exact integer bit-length for heapID up to 2^53 (clz32 fast path under 2^32, else
 * split the high word) — avoids Math.log2 rounding at exact powers of two.
 */
export function lebDepth(heapID: number): number {
    if (heapID < 1) return 0;
    if (heapID < 0x1_0000_0000) return 31 - Math.clz32(heapID >>> 0);
    const hi = Math.floor(heapID / 0x1_0000_0000);
    return 32 + (31 - Math.clz32(hi >>> 0));
}

function norm(x: number, y: number, z: number): [number, number, number] {
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    return [x * inv, y * inv, z * inv];
}

/** Octahedron face corners (apex, left, right) — mirror of leb_faceCorners. */
export function lebFaceCorners(face: number): LebTri {
    switch (face) {
        case 0:
            return { a: [0, 1, 0], l: [1, 0, 0], r: [0, 0, 1] };
        case 1:
            return { a: [0, 1, 0], l: [0, 0, 1], r: [-1, 0, 0] };
        case 2:
            return { a: [0, 1, 0], l: [-1, 0, 0], r: [0, 0, -1] };
        case 3:
            return { a: [0, 1, 0], l: [0, 0, -1], r: [1, 0, 0] };
        case 4:
            return { a: [0, -1, 0], l: [1, 0, 0], r: [0, 0, 1] };
        case 5:
            return { a: [0, -1, 0], l: [0, 0, 1], r: [-1, 0, 0] };
        case 6:
            return { a: [0, -1, 0], l: [-1, 0, 0], r: [0, 0, -1] };
        default:
            return { a: [0, -1, 0], l: [0, 0, -1], r: [1, 0, 0] };
    }
}

/**
 * Decode (heapID, depth) to its leaf triangle on the unit sphere. `depth` must equal
 * `lebDepth(heapID)` (>= 3); the face is the top bits, the remaining (depth-3) bits
 * are the LEB path, applied MSB first.
 */
export function lebDecode(heapID: number, depth: number): LebTri {
    const face = (heapID >>> (depth - 3)) - 8;
    const fc = lebFaceCorners(face);
    let v0 = fc.l;
    let v1 = fc.a;
    let v2 = fc.r;
    const steps = depth - 3;
    for (let s = 0; s < steps; s++) {
        const bitpos = steps - 1 - s;
        const bit = (heapID >>> bitpos) & 1;
        const m = norm(v0[0] + v2[0], v0[1] + v2[1], v0[2] + v2[2]);
        const ov1 = v1;
        if (bit === 0) {
            v1 = m;
            v2 = ov1;
        } else {
            v0 = ov1;
            v1 = m;
        }
    }
    // Return as (apex=v1, left=v0, right=v2) to match the LebTri field names.
    return { a: v1, l: v0, r: v2 };
}
