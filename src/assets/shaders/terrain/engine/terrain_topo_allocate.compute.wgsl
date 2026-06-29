// TERRAIN engine — Allocate pass (one thread per allocate-list entry). Faithful port of
// AllocateElement (update_utilities.hlsl): for each winner of the Split pass, reserve
// countOneBits(pattern) fresh pool slots by taking a disjoint base cursor via
// atomicAdd(memory[0]) and mapping each handle through pool_decodeBitComplement on the
// FROZEN (start-of-frame, reduced) sum-tree. Writes the new slot ids into the
// bisector's indices[]. Does NOT set pool bits here (the tree must stay frozen during
// allocation) — Bisect sets them afterwards.
//
// Composed after: engineWgslPreamble + terrain_u64.wgsl + terrain_pool.wgsl + common.
// pool_bitfield(0) is declared by terrain_pool.wgsl but unused here -> stripped (do not
// bind). pool_tree(1) is read by pool_decodeBitComplement.

@group(0) @binding(5)  var<storage, read_write> bisectorData : array<u32>;
@group(0) @binding(8)  var<storage, read_write> allocate     : array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> memory       : array<atomic<i32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let listIdx = linear_id(gid, nwg.x);
    if (listIdx >= atomicLoad(&allocate[0])) { return; }
    let currentID = atomicLoad(&allocate[1u + listIdx]);

    let b = currentID * BD_WORDS;
    let pattern = bisectorData[b + BD_PATTERN];
    if (pattern == NO_SPLIT) { return; }

    let numSlots = countOneBits(pattern);
    let firstBit = u32(atomicAdd(&memory[0], i32(numSlots)));
    if (numSlots >= 1u) { bisectorData[b + BD_INDEX0] = pool_decodeBitComplement(firstBit + 0u); }
    if (numSlots >= 2u) { bisectorData[b + BD_INDEX1] = pool_decodeBitComplement(firstBit + 1u); }
    if (numSlots >= 3u) { bisectorData[b + BD_INDEX2] = pool_decodeBitComplement(firstBit + 2u); }
}
