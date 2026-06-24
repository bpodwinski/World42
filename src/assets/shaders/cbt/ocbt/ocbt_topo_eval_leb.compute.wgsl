// OCBT EvaluateLEB pass (one thread per pool slot). Decodes each live slot's u64
// heap id to its three unit-sphere corners (REFERENCE leb convention, ocbt_eval_leb)
// and writes them to the positions buffer (9 f32/slot: c0.xyz, c1.xyz, c2.xyz). Dead
// slots are left untouched. This decouples the (depth-many) LEB decode from the
// vertex shader (option (a) of the plan): the render VS just reads positions[slot].
//
// Phase 2 writes UNIT DIRECTIONS only; the vertex shader applies radius + noise
// displacement (so shading stays identical to the proven implicit material). Phase 3
// moves radius/noise/camera-relative narrowing here in f64 for depth ~60.
//
// Composed after: engineWgslPreamble + ocbt_u64.wgsl + ocbt_eval_leb.wgsl + common.

@group(0) @binding(2)  var<storage, read>       heapID    : array<vec2<u32>>;
@group(0) @binding(19) var<storage, read_write> positions : array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let id = linear_id(gid, nwg.x);
    if (id >= OCBT_CAPACITY) { return; }

    let heap = heapID[id];
    if (heap_is_zero(heap)) { return; }

    let tri = ocbt_leb_decode(heap);
    let b = id * 9u;
    positions[b + 0u] = tri.c0.x;
    positions[b + 1u] = tri.c0.y;
    positions[b + 2u] = tri.c0.z;
    positions[b + 3u] = tri.c1.x;
    positions[b + 4u] = tri.c1.y;
    positions[b + 5u] = tri.c1.z;
    positions[b + 6u] = tri.c2.x;
    positions[b + 7u] = tri.c2.y;
    positions[b + 8u] = tri.c2.z;
}
