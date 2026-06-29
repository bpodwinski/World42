// Concurrent Binary Tree (Dupuy 2021) — read/write heap core, WGSL.
//
// Bit-packed heap of a perfect binary tree of depth CBT_MAX_DEPTH. A node at
// depth d stores its subtree leaf-count in (D - d + 1) bits; the deepest level
// (d == D) is the 1-bit-per-node leaf bitfield. A subdivision leaf at depth d is
// represented by exactly ONE set bit in its subtree (its leftmost depth-D
// descendant), so an internal node's value == number of subdivision leaves below
// it. cbt_decode descends while value > 1 and stops at the leaf (value == 1),
// recovering the leaf's true depth. (Validated bit-for-bit against a CPU model.)
//
// The includer must define `const CBT_MAX_DEPTH : u32 = <D>;` BEFORE this file and
// bind the heap at group(0) binding(0). Writes use atomicAnd/atomicOr with
// per-node-disjoint masks, so adjacent nodes sharing a u32 word never corrupt
// each other regardless of thread interleaving.

@group(0) @binding(0) var<storage, read_write> cbt_heap : array<atomic<u32>>;

fn cbt_bitSize(depth : u32) -> u32 {
    return CBT_MAX_DEPTH - depth + 1u;
}

// 2^(depth+1) + id * bitSize  — proven non-overlapping across all nodes.
fn cbt_bitID(id : u32, depth : u32) -> u32 {
    return (2u << depth) + id * cbt_bitSize(depth);
}

fn cbt_mask(n : u32) -> u32 {
    if (n >= 32u) { return 0xffffffffu; }
    return (1u << n) - 1u;
}

fn cbt_readBits(bitOffset : u32, bitCount : u32) -> u32 {
    let w = bitOffset >> 5u;
    let b = bitOffset & 31u;
    let first = min(bitCount, 32u - b);
    var r = (atomicLoad(&cbt_heap[w]) >> b) & cbt_mask(first);
    if (first < bitCount) {
        let sec = bitCount - first;
        r = r | ((atomicLoad(&cbt_heap[w + 1u]) & cbt_mask(sec)) << first);
    }
    return r;
}

fn cbt_writeBits(bitOffset : u32, bitCount : u32, value : u32) {
    let w = bitOffset >> 5u;
    let b = bitOffset & 31u;
    let first = min(bitCount, 32u - b);
    let m1 = cbt_mask(first) << b;
    atomicAnd(&cbt_heap[w], ~m1);
    atomicOr(&cbt_heap[w], (value << b) & m1);
    if (first < bitCount) {
        let sec = bitCount - first;
        let m2 = cbt_mask(sec);
        atomicAnd(&cbt_heap[w + 1u], ~m2);
        atomicOr(&cbt_heap[w + 1u], (value >> first) & m2);
    }
}

fn cbt_heapRead(id : u32, depth : u32) -> u32 {
    return cbt_readBits(cbt_bitID(id, depth), cbt_bitSize(depth));
}

fn cbt_heapWrite(id : u32, depth : u32, value : u32) {
    cbt_writeBits(cbt_bitID(id, depth), cbt_bitSize(depth), value);
}

// Bitfield index (0 .. 2^D-1) of node's leftmost depth-D descendant.
fn cbt_bfIndex(id : u32, depth : u32) -> u32 {
    return (id << (CBT_MAX_DEPTH - depth)) - (1u << CBT_MAX_DEPTH);
}

fn cbt_setBit(bitIndex : u32, value : u32) {
    cbt_heapWrite((1u << CBT_MAX_DEPTH) + bitIndex, CBT_MAX_DEPTH, value);
}

fn cbt_getBit(bitIndex : u32) -> u32 {
    return cbt_heapRead((1u << CBT_MAX_DEPTH) + bitIndex, CBT_MAX_DEPTH);
}

fn cbt_nodeCount() -> u32 {
    return cbt_heapRead(1u, 0u);
}

// Returns (heapId, depth) of the handle-th subdivision leaf (handle in
// [0, cbt_nodeCount())).
fn cbt_decode(handle : u32) -> vec2<u32> {
    var id : u32 = 1u;
    var depth : u32 = 0u;
    var h : u32 = handle;
    // Bounded loop (depth can never exceed CBT_MAX_DEPTH).
    for (var i : u32 = 0u; i < CBT_MAX_DEPTH; i = i + 1u) {
        if (cbt_heapRead(id, depth) <= 1u) {
            break;
        }
        let lid = id << 1u;
        let ldep = depth + 1u;
        let lv = cbt_heapRead(lid, ldep);
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
