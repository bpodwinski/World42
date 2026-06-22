// Debug/validation pass: decode every CBT leaf and write its 3 unit corners
// (9 floats) to an output buffer, so the GPU LEB decode can be diffed against the
// CPU reference. Composed after a `const CBT_MAX_DEPTH` line, cbt_heap_rw.wgsl
// (binding 0, provides cbt_decode/cbt_nodeCount) and cbt_leb.wgsl (leb_decode).

@group(0) @binding(1) var<storage, read_write> outCorners : array<f32>;

struct CbtDumpParams {
    data : vec4<u32>, // data.x = leaf count
};
@group(0) @binding(2) var<uniform> dumpParams : CbtDumpParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let handle = gid.x;
    if (handle >= dumpParams.data.x) {
        return;
    }
    let node = cbt_decode(handle); // vec2(id, depth)
    let tri = leb_decode(node.x, node.y);
    let o = handle * 9u;
    outCorners[o + 0u] = tri.a.x;
    outCorners[o + 1u] = tri.a.y;
    outCorners[o + 2u] = tri.a.z;
    outCorners[o + 3u] = tri.l.x;
    outCorners[o + 4u] = tri.l.y;
    outCorners[o + 5u] = tri.l.z;
    outCorners[o + 6u] = tri.r.x;
    outCorners[o + 7u] = tri.r.y;
    outCorners[o + 8u] = tri.r.z;
}
