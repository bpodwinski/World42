// OCBT engine — CopyNeighbors pass (one thread per neighbor word, 3*CAPACITY total).
// There is no in-WGSL buffer-copy API in Babylon, so this trivial compute copies the
// current neighbor buffer into the next (ping-pong) buffer before Bisect runs. Bisect
// then overwrites only the rows of slots that subdivided, leaving unchanged slots'
// neighbors intact in the next buffer (mirror of mesh_updater's pre-Bisect copy).
//
// Composed after: engineWgslPreamble + common.

@group(0) @binding(3) var<storage, read>       nbIn  : array<u32>;
@group(0) @binding(4) var<storage, read_write> nbOut : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let i = linear_id(gid, nwg.x);
    if (i >= OCBT_CAPACITY * NB_WORDS) { return; }
    nbOut[i] = nbIn[i];
}
