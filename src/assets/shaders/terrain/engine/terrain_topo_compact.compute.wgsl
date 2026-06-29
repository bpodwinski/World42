// TERRAIN draw compaction (one thread per pool slot). Appends every LIVE slot index to a
// contiguous list so the render draws `liveCount` instances (instance i -> indices[i] ->
// slot) instead of one per pool slot. The vertex shader runs the (expensive) fbm noise
// per vertex, so cutting the instance count from CAPACITY (e.g. 1,048,576) to the live
// count (e.g. ~60k) is the big draw-side win once frustum culling concentrates the pool.
//
// drawCount[0] is cleared by the CPU each frame before this pass (a 4-byte buffer.update),
// so no shared reset shader change is needed. Order is irrelevant (the list is just the
// set of live slots); the render gates any stale tail entry by heap id 0.
//
// Composed after: engineWgslPreamble + terrain_u64.wgsl + common.

@group(0) @binding(2)  var<storage, read>       heapID    : array<vec2<u32>>;
@group(0) @binding(13) var<storage, read_write> indices   : array<u32>;
@group(0) @binding(21) var<storage, read_write> drawCount : array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let id = linear_id(gid, nwg.x);
    if (id >= TERRAIN_CAPACITY) { return; }
    if (heap_is_zero(heapID[id])) { return; }
    let slot = atomicAdd(&drawCount[0], 1u);
    indices[slot] = id;
}
