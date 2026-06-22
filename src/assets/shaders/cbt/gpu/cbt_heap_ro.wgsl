// CBT heap — READ-ONLY view, WGSL. Same bit layout as cbt_heap_rw.wgsl but bound
// as a non-atomic read-only storage buffer, for the render vertex shader (WebGPU
// forbids writable storage in the vertex stage). The includer must define
// `const CBT_MAX_DEPTH : u32 = <D>;` and declare the buffer:
//   var<storage, read> cbt_heap : array<u32>;

fn cbt_bitSize(depth : u32) -> u32 {
    return CBT_MAX_DEPTH - depth + 1u;
}

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
    var r = (cbt_heap[w] >> b) & cbt_mask(first);
    if (first < bitCount) {
        let sec = bitCount - first;
        r = r | ((cbt_heap[w + 1u] & cbt_mask(sec)) << first);
    }
    return r;
}

fn cbt_heapRead(id : u32, depth : u32) -> u32 {
    return cbt_readBits(cbt_bitID(id, depth), cbt_bitSize(depth));
}

fn cbt_nodeCount() -> u32 {
    return cbt_heapRead(1u, 0u);
}

fn cbt_decode(handle : u32) -> vec2<u32> {
    var id : u32 = 1u;
    var depth : u32 = 0u;
    var h : u32 = handle;
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
