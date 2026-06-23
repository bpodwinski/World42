/**
 * OCBT pool constants & layout helpers (shared by the TS mirror, the GPU buffer
 * sizing, and — via codegen — the WGSL). The OCBT (Benyoub & Dupuy, HPG 2024) uses
 * a Concurrent Binary Tree as a fixed-size MEMORY-POOL ALLOCATOR: a bitfield of
 * `capacity` slots (bit = slot allocated) plus a binary sum-tree giving O(log
 * capacity) "find the i-th allocated/free slot". Capacity is independent of the
 * terrain subdivision depth — that is the whole point (cost/memory decoupled from
 * depth, unlike the implicit `2^D` CBT in ../gpu/).
 */

/** Default pool capacity: 2^18 = 262 144 bisector slots (see plan; drop to 2^17 if memory-tight). */
export const OCBT_DEFAULT_CAPACITY = 1 << 18;

/** Throw unless `n` is a power of two and >= 2 (the sum-tree requires it). */
export function assertPowerOfTwo(n: number): void {
    if (n < 2 || (n & (n - 1)) !== 0) {
        throw new Error(`OCBT capacity must be a power of two >= 2, got ${n}`);
    }
}

/** Number of u32 words to hold `capacity` packed bits (bitfield). */
export function bitfieldWordCount(capacity: number): number {
    return Math.ceil(capacity / 32);
}

/** log2 of a power-of-two capacity. */
export function log2PowerOfTwo(capacity: number): number {
    assertPowerOfTwo(capacity);
    return 31 - Math.clz32(capacity);
}
