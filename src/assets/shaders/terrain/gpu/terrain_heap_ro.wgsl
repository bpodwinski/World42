// TERRAIN heap — READ-ONLY view, WGSL. Same bit layout as terrain_heap_rw.wgsl but bound
// as a non-atomic read-only storage buffer, for the render vertex shader (WebGPU
// forbids writable storage in the vertex stage). The includer must define
// `const TERRAIN_MAX_DEPTH : u32 = <D>;` and declare the buffer:
//   var<storage, read> terrain_heap : array<u32>;

fn terrain_bitSize(depth : u32) -> u32 {
    return TERRAIN_MAX_DEPTH - depth + 1u;
}

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
    var r = (terrain_heap[w] >> b) & terrain_mask(first);
    if (first < bitCount) {
        let sec = bitCount - first;
        r = r | ((terrain_heap[w + 1u] & terrain_mask(sec)) << first);
    }
    return r;
}

fn terrain_heapRead(id : u32, depth : u32) -> u32 {
    return terrain_readBits(terrain_bitID(id, depth), terrain_bitSize(depth));
}

fn terrain_nodeCount() -> u32 {
    return terrain_heapRead(1u, 0u);
}

fn terrain_decode(handle : u32) -> vec2<u32> {
    var id : u32 = 1u;
    var depth : u32 = 0u;
    var h : u32 = handle;
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
