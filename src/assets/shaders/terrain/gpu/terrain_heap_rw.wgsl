// Concurrent Binary Tree (Dupuy 2021) — read/write heap core, WGSL.
//
// Bit-packed heap of a perfect binary tree of depth TERRAIN_MAX_DEPTH. A node at
// depth d stores its subtree leaf-count in (D - d + 1) bits; the deepest level
// (d == D) is the 1-bit-per-node leaf bitfield. A subdivision leaf at depth d is
// represented by exactly ONE set bit in its subtree (its leftmost depth-D
// descendant), so an internal node's value == number of subdivision leaves below
// it. terrain_decode descends while value > 1 and stops at the leaf (value == 1),
// recovering the leaf's true depth. (Validated bit-for-bit against a CPU model.)
//
// The includer must define `const TERRAIN_MAX_DEPTH : u32 = <D>;` BEFORE this file and
// bind the heap at group(0) binding(0). Writes use atomicAnd/atomicOr with
// per-node-disjoint masks, so adjacent nodes sharing a u32 word never corrupt
// each other regardless of thread interleaving.

@group(0) @binding(0) var<storage, read_write> terrain_heap : array<atomic<u32>>;

fn terrain_bitSize(depth : u32) -> u32 {
    return TERRAIN_MAX_DEPTH - depth + 1u;
}

// 2^(depth+1) + id * bitSize  — proven non-overlapping across all nodes.
fn terrain_bitID(id : u32, depth : u32) -> u32 {
    return (2u << depth) + id * terrain_bitSize(depth);
}

fn terrain_mask(n : u32) -> u32 {
    if (n >= 32u) { return 0xffffffffu; }
    return (1u << n) - 1u;
}

fn terrain_readBits(bitOffset : u32, bitCount : u32) -> u32 {
    let w = bitOffset >> 5u;
    let b = bitOffset & 31u;
    let first = min(bitCount, 32u - b);
    var r = (atomicLoad(&terrain_heap[w]) >> b) & terrain_mask(first);
    if (first < bitCount) {
        let sec = bitCount - first;
        r = r | ((atomicLoad(&terrain_heap[w + 1u]) & terrain_mask(sec)) << first);
    }
    return r;
}

fn terrain_writeBits(bitOffset : u32, bitCount : u32, value : u32) {
    let w = bitOffset >> 5u;
    let b = bitOffset & 31u;
    let first = min(bitCount, 32u - b);
    let m1 = terrain_mask(first) << b;
    atomicAnd(&terrain_heap[w], ~m1);
    atomicOr(&terrain_heap[w], (value << b) & m1);
    if (first < bitCount) {
        let sec = bitCount - first;
        let m2 = terrain_mask(sec);
        atomicAnd(&terrain_heap[w + 1u], ~m2);
        atomicOr(&terrain_heap[w + 1u], (value >> first) & m2);
    }
}

fn terrain_heapRead(id : u32, depth : u32) -> u32 {
    return terrain_readBits(terrain_bitID(id, depth), terrain_bitSize(depth));
}

fn terrain_heapWrite(id : u32, depth : u32, value : u32) {
    terrain_writeBits(terrain_bitID(id, depth), terrain_bitSize(depth), value);
}

// Bitfield index (0 .. 2^D-1) of node's leftmost depth-D descendant.
fn terrain_bfIndex(id : u32, depth : u32) -> u32 {
    return (id << (TERRAIN_MAX_DEPTH - depth)) - (1u << TERRAIN_MAX_DEPTH);
}

fn terrain_setBit(bitIndex : u32, value : u32) {
    terrain_heapWrite((1u << TERRAIN_MAX_DEPTH) + bitIndex, TERRAIN_MAX_DEPTH, value);
}

fn terrain_getBit(bitIndex : u32) -> u32 {
    return terrain_heapRead((1u << TERRAIN_MAX_DEPTH) + bitIndex, TERRAIN_MAX_DEPTH);
}

fn terrain_nodeCount() -> u32 {
    return terrain_heapRead(1u, 0u);
}

// Returns (heapId, depth) of the handle-th subdivision leaf (handle in
// [0, terrain_nodeCount())).
fn terrain_decode(handle : u32) -> vec2<u32> {
    var id : u32 = 1u;
    var depth : u32 = 0u;
    var h : u32 = handle;
    // Bounded loop (depth can never exceed TERRAIN_MAX_DEPTH).
    for (var i : u32 = 0u; i < TERRAIN_MAX_DEPTH; i = i + 1u) {
        if (terrain_heapRead(id, depth) <= 1u) {
            break;
        }
        let lid = id << 1u;
        let ldep = depth + 1u;
        let lv = terrain_heapRead(lid, ldep);
        if (h < lv) {
            id = lid;
            depth = ldep;
        } else {
            h = h - lv;
            id = lid + 1u;
            depth = ldep;
        }
    }
    return vec2<u32>(id, depth);
}
