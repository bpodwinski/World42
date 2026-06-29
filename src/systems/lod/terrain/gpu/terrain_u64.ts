/**
 * u64 emulation for the OCBT path — the CPU mirror of `ocbt_u64.wgsl`.
 *
 * WGSL has no 64-bit integer type, yet OCBT heap IDs need ~63 bits at terrain
 * depth ~60 (the root face is at depth 3, each subdivision adds one bit). We
 * therefore carry a u64 as a `vec2<u32>` = `[lo, hi]` (low 32 bits, high 32 bits)
 * and implement exactly the operations the LEB decode and bisector topology use:
 * `firstLeadingBit` (-> tree depth), bit extraction, shifts, bitwise and/or/not,
 * and unsigned comparison. See `references/large_cbt/shaders/shader_lib/leb.hlsl`
 * (`leb_depth`, `leb__GetBitValue`, the tabulated decode masks) for the native
 * `uint64_t` originals these mirror.
 *
 * This TS module is the golden oracle: `ocbt_u64.test.ts` checks it against
 * BigInt, and the GPU<->mirror cross-check (later phases) reads back heap IDs and
 * compares against values produced here. Each lane is kept in the unsigned 32-bit
 * range via `>>> 0` so the two representations stay bit-identical.
 *
 * Shift safety: WGSL never shifts a u32 by >= 32 (undefined there), so every
 * routine routes a >= 32 shift through the "other lane" branch and guards n == 0,
 * keeping all actual u32 shift amounts in 1..31 — mirror this in the WGSL.
 */

/** A u64 as `[low32, high32]`, each held as an unsigned 32-bit integer. */
export type U64 = readonly [number, number];

const u32 = (x: number): number => x >>> 0;

/** Build a u64 from explicit low/high 32-bit halves. */
export function u64(lo: number, hi = 0): U64 {
    return [u32(lo), u32(hi)];
}

/** Build a u64 from a 32-bit value (high half zero). */
export function u64FromU32(lo: number): U64 {
    return [u32(lo), 0];
}

/** Convert an arbitrary BigInt (taken mod 2^64) to a u64 — test/seed helper. */
export function u64FromBigInt(v: bigint): U64 {
    const m = (1n << 32n) - 1n;
    return [Number(v & m) >>> 0, Number((v >> 32n) & m) >>> 0];
}

/** Exact BigInt value of a u64 — test/oracle helper. */
export function u64ToBigInt(a: U64): bigint {
    return (BigInt(a[1] >>> 0) << 32n) | BigInt(a[0] >>> 0);
}

export function u64Eq(a: U64, b: U64): boolean {
    return a[0] === b[0] && a[1] === b[1];
}

export function u64And(a: U64, b: U64): U64 {
    return [u32(a[0] & b[0]), u32(a[1] & b[1])];
}

export function u64Or(a: U64, b: U64): U64 {
    return [u32(a[0] | b[0]), u32(a[1] | b[1])];
}

export function u64Xor(a: U64, b: U64): U64 {
    return [u32(a[0] ^ b[0]), u32(a[1] ^ b[1])];
}

export function u64Not(a: U64): U64 {
    return [u32(~a[0]), u32(~a[1])];
}

/** Logical shift left by `n` (0..63); bits shifted past bit 63 are dropped. */
export function u64Shl(a: U64, n: number): U64 {
    const m = n & 63;
    if (m === 0) return [a[0], a[1]];
    if (m >= 32) return [0, u32(a[0] << (m - 32))];
    return [u32(a[0] << m), u32((a[1] << m) | (a[0] >>> (32 - m)))];
}

/** Logical shift right by `n` (0..63). */
export function u64Shr(a: U64, n: number): U64 {
    const m = n & 63;
    if (m === 0) return [a[0], a[1]];
    if (m >= 32) return [u32(a[1] >>> (m - 32)), 0];
    return [u32((a[0] >>> m) | (a[1] << (32 - m))), u32(a[1] >>> m)];
}

/** Index (0..63) of the most-significant set bit, or -1 if `a` is zero. */
export function u64FindMSB(a: U64): number {
    if (a[1] !== 0) return 63 - Math.clz32(a[1]);
    if (a[0] !== 0) return 31 - Math.clz32(a[0]);
    return -1;
}

/** Value (0 or 1) of bit `i` (0..63). */
export function u64Bit(a: U64, i: number): 0 | 1 {
    if (i < 32) return ((a[0] >>> i) & 1) as 0 | 1;
    return ((a[1] >>> (i - 32)) & 1) as 0 | 1;
}

/** Unsigned compare: -1 if a<b, 0 if a==b, 1 if a>b. */
export function u64Cmp(a: U64, b: U64): -1 | 0 | 1 {
    const ah = a[1] >>> 0;
    const bh = b[1] >>> 0;
    if (ah !== bh) return ah < bh ? -1 : 1;
    const al = a[0] >>> 0;
    const bl = b[0] >>> 0;
    if (al !== bl) return al < bl ? -1 : 1;
    return 0;
}

export function u64Gt(a: U64, b: U64): boolean {
    return u64Cmp(a, b) > 0;
}

export function u64Lt(a: U64, b: U64): boolean {
    return u64Cmp(a, b) < 0;
}

/**
 * Tree depth of a heap ID (root face at id 1..). Equals `firstLeadingBit(heapID)`:
 * a heap ID with its MSB at bit `d` sits at depth `d`. Returns 0 for a zero ID,
 * matching `leb_depth` in `leb.hlsl`.
 */
export function u64Depth(heapID: U64): number {
    const msb = u64FindMSB(heapID);
    return msb < 0 ? 0 : msb;
}
