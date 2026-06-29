// TERRAIN memory-pool allocator — GPU core, WGSL. The GPU twin of the CPU oracle
// src/systems/lod/terrain/gpu/terrain_cpu_mirror.ts: same decode/reduce semantics, so a
// readback cross-check (later phase) compares bit-for-bit.
//
// A Concurrent Binary Tree used as a fixed-capacity slot allocator (Benyoub & Dupuy,
// HPG 2024). `pool_bitfield` holds one bit per slot (1 = allocated); `pool_tree` is a
// 1-indexed binary sum-tree (tree[1] = total allocated, leaves at [CAPACITY,
// 2*CAPACITY)). decode_bit / decode_bit_complement find the i-th allocated / free
// slot in O(log CAPACITY). Cost is tied to the fixed pool size, NOT the terrain
// subdivision depth — the whole point versus the implicit 2^D TERRAIN in ../gpu/.
//
// This is the simple per-slot tree (correctness-first, exact parity with the tested
// CPU mirror, and it reuses this project's level-per-dispatch reduction pattern from
// terrain_sum_reduction.compute.wgsl). The reference's packed variable-bit-width tree
// (terrain_256k.hlsl) is a memory/LDS optimization deferred to a later tuning pass; the
// decode RESULTS are identical, so the mirror and the cross-check stay valid.
//
// The includer must define, BEFORE this file:
//     const TERRAIN_CAPACITY : u32 = <power of two>;
//     const TERRAIN_DEPTH    : u32 = <log2(TERRAIN_CAPACITY)>;
// and bind the bitfield at group(0) binding(0), the tree at group(0) binding(1).
// (See terrain_buffers.ts `poolWgslPreamble` for the generated const lines.)

// One bit per slot. Atomic because the Allocate pass sets many bits concurrently.
@group(0) @binding(0) var<storage, read_write> pool_bitfield : array<atomic<u32>>;
// 1-indexed sum-tree, size 2*CAPACITY. Written only by the reduce (disjoint per
// dispatch) and read by decode — never concurrently — so plain (non-atomic).
@group(0) @binding(1) var<storage, read_write> pool_tree : array<u32>;

fn pool_getBit(slot : u32) -> u32 {
    return (atomicLoad(&pool_bitfield[slot >> 5u]) >> (slot & 31u)) & 1u;
}

// Set or clear a slot's bit. Atomic with a single-bit mask, so threads touching
// different slots in the same word never corrupt each other.
fn pool_setBitAtomic(slot : u32, state : bool) {
    let w = slot >> 5u;
    let m = 1u << (slot & 31u);
    if (state) {
        atomicOr(&pool_bitfield[w], m);
    } else {
        atomicAnd(&pool_bitfield[w], ~m);
    }
}

// Total allocated slots (sum-tree root). Valid after a reduce.
fn pool_count() -> u32 {
    return pool_tree[1];
}

fn pool_freeCount() -> u32 {
    return TERRAIN_CAPACITY - pool_tree[1];
}

// --- Reduce (rebuild the tree from the bitfield), one level per dispatch ---------

// Leaf prepass: copy each slot's bit into its leaf node. One thread per slot.
fn pool_reduceLeaf(slot : u32) {
    pool_tree[TERRAIN_CAPACITY + slot] = pool_getBit(slot);
}

// Reduce internal level `level` (0..TERRAIN_DEPTH-1). Level L has 2^L nodes at absolute
// ids [2^L, 2^(L+1)); `t` is the node index within the level (0..2^L). The driver
// dispatches levels TERRAIN_DEPTH-1 .. 0 in order, mirroring terrain_sum_reduction.
fn pool_reduceLevel(level : u32, t : u32) {
    let id = (1u << level) + t;
    pool_tree[id] = pool_tree[id << 1u] + pool_tree[(id << 1u) | 1u];
}

// --- Decode ----------------------------------------------------------------------

// Slot of the `handle`-th allocated bit (0-based, ascending). Descend, going left
// while handle < left-subtree count, else right (subtracting). Mirrors
// TerrainPool.decodeBit. Requires handle < pool_count().
fn pool_decodeBit(handle : u32) -> u32 {
    var id = 1u;
    var h = handle;
    for (var d = 0u; d < TERRAIN_DEPTH; d = d + 1u) {
        let left = pool_tree[id << 1u];
        if (h < left) {
            id = id << 1u;
        } else {
            h = h - left;
            id = (id << 1u) | 1u;
        }
    }
    return id - TERRAIN_CAPACITY;
}

// Slot of the `handle`-th free bit (0-based, ascending). free-in-subtree =
// halvedCapacity - allocatedCount. Mirrors TerrainPool.decodeBitComplement. Requires
// handle < pool_freeCount().
fn pool_decodeBitComplement(handle : u32) -> u32 {
    var id = 1u;
    var h = handle;
    var c = TERRAIN_CAPACITY >> 1u;
    for (var d = 0u; d < TERRAIN_DEPTH; d = d + 1u) {
        let freeLeft = c - pool_tree[id << 1u];
        if (h < freeLeft) {
            id = id << 1u;
        } else {
            h = h - freeLeft;
            id = (id << 1u) | 1u;
        }
        c = c >> 1u;
    }
    return id - TERRAIN_CAPACITY;
}
