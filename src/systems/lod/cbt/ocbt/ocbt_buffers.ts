/**
 * OCBT pool buffer layout — the single source of truth for the GPU pool's buffer
 * sizes, binding slots, and the WGSL `const` preamble. Shared by the TS mirror, the
 * kernel (which creates the actual Babylon `StorageBuffer`s from these sizes), and
 * the WGSL (which is composed with `poolWgslPreamble(...)` prepended before
 * `ocbt_pool.wgsl`). Keeping the dimensions here — and pure, with no Babylon import —
 * lets them be unit-tested in Node and guarantees the CPU mirror, the buffers, and
 * the shader agree on capacity.
 *
 * Layout (simple per-slot tree, matching `ocbt_cpu_mirror.ts` and `ocbt_pool.wgsl`):
 *   binding 0  pool_bitfield : array<atomic<u32>>  — capacity/32 words (1 bit/slot)
 *   binding 1  pool_tree     : array<u32>          — 2*capacity words (1-indexed sum-tree)
 */
import {
    OCBT_DEFAULT_CAPACITY,
    assertPowerOfTwo,
    bitfieldWordCount,
    log2PowerOfTwo
} from './ocbt_pool';

/** Binding slot of the pool allocation bitfield (group 0). */
export const POOL_BITFIELD_BINDING = 0;
/** Binding slot of the pool sum-tree (group 0). */
export const POOL_TREE_BINDING = 1;

const BYTES_PER_U32 = 4;

/** u32 words in the pool bitfield (one bit per slot). */
export function poolBitfieldWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    return bitfieldWordCount(capacity);
}

/** u32 words in the pool sum-tree (1-indexed; index 0 unused, leaves at [cap, 2cap)). */
export function poolTreeWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    return 2 * capacity;
}

/** Fully-resolved pool buffer layout for a given capacity. */
export interface PoolBufferLayout {
    readonly capacity: number;
    readonly depth: number;
    readonly bitfieldWords: number;
    readonly treeWords: number;
    readonly bitfieldBytes: number;
    readonly treeBytes: number;
    /** Combined storage footprint of both pool buffers, in bytes. */
    readonly totalBytes: number;
    readonly bitfieldBinding: number;
    readonly treeBinding: number;
}

export function poolLayout(capacity: number = OCBT_DEFAULT_CAPACITY): PoolBufferLayout {
    assertPowerOfTwo(capacity);
    const bitfieldWords = poolBitfieldWords(capacity);
    const treeWords = poolTreeWords(capacity);
    const bitfieldBytes = bitfieldWords * BYTES_PER_U32;
    const treeBytes = treeWords * BYTES_PER_U32;
    return {
        capacity,
        depth: log2PowerOfTwo(capacity),
        bitfieldWords,
        treeWords,
        bitfieldBytes,
        treeBytes,
        totalBytes: bitfieldBytes + treeBytes,
        bitfieldBinding: POOL_BITFIELD_BINDING,
        treeBinding: POOL_TREE_BINDING
    };
}

/**
 * WGSL `const` preamble that the shader composer prepends before `ocbt_pool.wgsl`.
 * Emits `OCBT_CAPACITY` and `OCBT_DEPTH` so the GPU core's loop bounds and the slot
 * offset (`id - OCBT_CAPACITY`) are specialized to this capacity.
 */
export function poolWgslPreamble(capacity: number = OCBT_DEFAULT_CAPACITY): string {
    assertPowerOfTwo(capacity);
    const depth = log2PowerOfTwo(capacity);
    return (
        `const OCBT_CAPACITY : u32 = ${capacity >>> 0}u;\n` +
        `const OCBT_DEPTH : u32 = ${depth}u;\n`
    );
}
