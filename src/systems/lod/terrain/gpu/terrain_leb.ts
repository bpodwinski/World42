/**
 * Heap-id depth helper for the TERRAIN path. The vertex decode itself lives in
 * `terrain_eval_leb.ts` (`terrainCorners`, the single canonical reference-convention matrix
 * decoder); the legacy recursive-slerp `lebDecode` / `lebFaceCorners` were removed when
 * the oracle and GPU unified on that decoder. Only `lebDepth` remains here, used by
 * `terrain_eval_leb.ts` to derive a node's tree depth from its heap id.
 *
 * heapID is a JS number (exact for depth < 53); the GPU carries it as the u64 emulation
 * (`terrain_u64`). depth = firstbithigh = the bit length minus one.
 */

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
