// CBT sum-reduction — one level per dispatch. Reduces depth `passDepth` from its
// children at `passDepth + 1`. The driver dispatches levels D-1 .. 0 in order
// (each level depends on the one below). Composed after a `const CBT_MAX_DEPTH`
// line and the read/write heap core (cbt_heap_rw.wgsl), which owns binding(0).

// data.x = passDepth (packed as vec4<u32> to dodge UBO scalar-alignment surprises).
struct CbtReduceParams {
    data : vec4<u32>,
};

@group(0) @binding(1) var<uniform> reduceParams : CbtReduceParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let depth = reduceParams.data.x;
    let count = 1u << depth;          // number of nodes at this level
    let t = gid.x;
    if (t >= count) {
        return;
    }
    let id = count + t;               // heap id at this depth
    let x0 = cbt_heapRead(id << 1u, depth + 1u);
    let x1 = cbt_heapRead((id << 1u) | 1u, depth + 1u);
    cbt_heapWrite(id, depth, x0 + x1);
}
