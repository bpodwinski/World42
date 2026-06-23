// u64 emulation for the OCBT path. WGSL has no 64-bit integer type, yet OCBT heap
// IDs need ~63 bits at terrain depth ~60, so a u64 is carried as a vec2<u32> =
// (lo, hi): .x holds the low 32 bits, .y the high 32 bits. This mirrors
// src/systems/lod/cbt/ocbt/ocbt_u64.ts EXACTLY (same lane layout, same branches),
// so the GPU and the CPU oracle decode every heap ID identically.
//
// Implemented set matches the native uint64_t ops used by leb.hlsl: firstLeadingBit
// (tree depth), bit extraction, shifts, and/or/not, and unsigned comparison.
//
// Shift safety: WGSL leaves a u32 shift by >= 32 undefined, so every routine routes
// a >= 32 shift through the other lane and guards n == 0 — all actual u32 shift
// amounts stay in 1..31.

fn u64_from_u32(lo : u32) -> vec2<u32> {
    return vec2<u32>(lo, 0u);
}

fn u64_eq(a : vec2<u32>, b : vec2<u32>) -> bool {
    return a.x == b.x && a.y == b.y;
}

fn u64_and(a : vec2<u32>, b : vec2<u32>) -> vec2<u32> {
    return a & b;
}

fn u64_or(a : vec2<u32>, b : vec2<u32>) -> vec2<u32> {
    return a | b;
}

fn u64_xor(a : vec2<u32>, b : vec2<u32>) -> vec2<u32> {
    return a ^ b;
}

fn u64_not(a : vec2<u32>) -> vec2<u32> {
    return ~a;
}

// Logical shift left by n (0..63); bits past bit 63 are dropped.
fn u64_shl(a : vec2<u32>, n : u32) -> vec2<u32> {
    let m = n & 63u;
    if (m == 0u) {
        return a;
    }
    if (m >= 32u) {
        return vec2<u32>(0u, a.x << (m - 32u));
    }
    return vec2<u32>(a.x << m, (a.y << m) | (a.x >> (32u - m)));
}

// Logical shift right by n (0..63).
fn u64_shr(a : vec2<u32>, n : u32) -> vec2<u32> {
    let m = n & 63u;
    if (m == 0u) {
        return a;
    }
    if (m >= 32u) {
        return vec2<u32>(a.y >> (m - 32u), 0u);
    }
    return vec2<u32>((a.x >> m) | (a.y << (32u - m)), a.y >> m);
}

// Index (0..63) of the most-significant set bit, or -1 if a is zero.
fn u64_find_msb(a : vec2<u32>) -> i32 {
    if (a.y != 0u) {
        return 32 + i32(firstLeadingBit(a.y));
    }
    if (a.x != 0u) {
        return i32(firstLeadingBit(a.x));
    }
    return -1;
}

// Value (0 or 1) of bit i (0..63).
fn u64_bit(a : vec2<u32>, i : u32) -> u32 {
    if (i < 32u) {
        return (a.x >> i) & 1u;
    }
    return (a.y >> (i - 32u)) & 1u;
}

// Unsigned compare: -1 if a<b, 0 if a==b, 1 if a>b.
fn u64_cmp(a : vec2<u32>, b : vec2<u32>) -> i32 {
    if (a.y != b.y) {
        return select(1, -1, a.y < b.y);
    }
    if (a.x != b.x) {
        return select(1, -1, a.x < b.x);
    }
    return 0;
}

fn u64_gt(a : vec2<u32>, b : vec2<u32>) -> bool {
    return u64_cmp(a, b) > 0;
}

fn u64_lt(a : vec2<u32>, b : vec2<u32>) -> bool {
    return u64_cmp(a, b) < 0;
}

// Tree depth of a heap ID. Equals firstLeadingBit(heapID); 0 for a zero ID,
// matching leb_depth in leb.hlsl.
fn u64_depth(heap_id : vec2<u32>) -> u32 {
    let msb = u64_find_msb(heap_id);
    return select(u32(msb), 0u, msb < 0);
}
