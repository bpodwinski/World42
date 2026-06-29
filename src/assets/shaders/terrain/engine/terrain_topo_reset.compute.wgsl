// TERRAIN engine — Reset pass (1 thread). Port of ResetBuffers (update_utilities.hlsl),
// reduced to the buffers the topology cross-check uses (no simplify / indirect-draw).
// Zeroes the per-frame work counters and primes the free-slot memory budget from the
// pool sum-tree (which MUST have been reduced from the current bitfield first).
//
// Composed after: engineWgslPreamble + terrain_u64.wgsl + terrain_pool.wgsl + common.
// pool_bitfield(0) is declared by terrain_pool.wgsl but unused here -> reflection strips
// it (do not bind it). pool_tree(1) is read by pool_freeCount().

@group(0) @binding(6)  var<storage, read_write> classification : array<atomic<u32>>;
@group(0) @binding(7)  var<storage, read_write> simplification : array<atomic<u32>>;
@group(0) @binding(8)  var<storage, read_write> allocate       : array<atomic<u32>>;
@group(0) @binding(9)  var<storage, read_write> propagate      : array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> memory         : array<atomic<i32>>;

@compute @workgroup_size(1)
fn main() {
    // Free-slot budget for SplitElement's atomic reservation (signed: it transiently
    // goes negative when over-subscribed, then is refunded).
    atomicStore(&memory[0], 0);                           // bit-alloc cursor
    atomicStore(&memory[1], i32(pool_freeCount()));       // remaining free slots

    atomicStore(&classification[SPLIT_COUNTER], 0u);
    atomicStore(&classification[SIMPLIFY_COUNTER], 0u);

    atomicStore(&allocate[0], 0u);
    atomicStore(&simplification[0], 0u);

    atomicStore(&propagate[0], 0u);
    atomicStore(&propagate[1], 0u);
}
