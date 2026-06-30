// TERRAIN EvaluateLEB — delta f32 variant (one thread per newly-allocated slot).
// Covers slots created by the Allocate pass in the CURRENT frame that are absent
// from the previous compact's bisectorIndices list. Dispatched via ARG.ALLOCATE.
//
// Composed after: engineWgslPreamble + terrain_u64.wgsl + terrain_eval_leb.wgsl
//   + terrain_topo_common.wgsl.

@group(0) @binding(2)  var<storage, read>       heapID   : array<vec2<u32>>;
@group(0) @binding(8)  var<storage, read>        allocate : array<u32>;
@group(0) @binding(19) var<storage, read_write>  positions: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let i = linear_id(gid, nwg.x);
    if (i >= allocate[0]) { return; }
    let id = allocate[i + 1u];

    let heap = heapID[id];
    // No heap_is_zero guard: every allocate[] entry is a freshly-created live slot.

    let tri = terrain_leb_decode(heap);
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
