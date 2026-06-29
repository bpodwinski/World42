// OCBT pool reduce — one level per dispatch, rebuilding the sum-tree from the
// bitfield. Composed after the pool preamble (OCBT_CAPACITY/OCBT_DEPTH) and the pool
// core (ocbt_pool.wgsl, which owns bindings 0 = bitfield, 1 = tree).
//
// The driver dispatches: level == OCBT_DEPTH first (the leaf prepass: copy each
// slot's bit into its leaf node), then levels OCBT_DEPTH-1 .. 0 in order (each
// internal level sums its two children). Mirrors cbt_sum_reduction.compute.wgsl,
// over the fixed pool instead of the 2^D tree.

struct OcbtReduceParams {
    // data.x = level (OCBT_DEPTH = leaf prepass, else internal level index).
    data : vec4<u32>,
};

@group(0) @binding(2) var<uniform> reduceParams : OcbtReduceParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
    let level = reduceParams.data.x;
    // 2D grid linear index: dispatch X is capped at 65535 workgroups, overflow
    // spills into Y. For 1D dispatches (Y=1) this is just gid.x.
    let t = gid.x + gid.y * nwg.x * 256u;

    if (level == OCBT_DEPTH) {
        if (t >= OCBT_CAPACITY) {
            return;
        }
        pool_reduceLeaf(t);
        return;
    }

    let count = 1u << level;
    if (t >= count) {
        return;
    }
    pool_reduceLevel(level, t);
}
