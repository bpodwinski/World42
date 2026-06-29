// OCBT pool decode validation — runs the WGSL decode_bit / decode_bit_complement on
// the GPU so the cross-check exercises the actual shader code, not just the tree.
// This targets the plan's #1 risk (bitfield descent off-by-one): the tree can be
// correct while a decode shift/loop-bound is wrong, so we validate decode directly on
// real hardware. Composed after the pool preamble + core (bindings 0 = bitfield, 1 =
// tree); the tree must already be reduced. Counts are read from the tree itself, so
// no extra uniform and no CPU sync between the reduce and this pass.
//
// Output layout (decodeOut, length OCBT_CAPACITY): indices [0, nAlloc) hold
// decode_bit(i) (i-th allocated slot); indices [nAlloc, OCBT_CAPACITY) hold
// decode_bit_complement(i) (i-th free slot, with i = index - nAlloc).

@group(0) @binding(2) var<storage, read_write> decodeOut : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
    let t = gid.x + gid.y * nwg.x * 256u;
    if (t >= OCBT_CAPACITY) {
        return;
    }
    let nAlloc = pool_count();
    if (t < nAlloc) {
        decodeOut[t] = pool_decodeBit(t);
    } else {
        decodeOut[t] = pool_decodeBitComplement(t - nAlloc);
    }
}
