// TERRAIN CopyNeighbors — active-list variant (one thread per ACTIVE slot, copies NB_WORDS words).
// Replaces the O(3*capacity) word-level ping-pong with an O(active) slot-level copy.
// Dispatched via dispatchIndirect using record 9 (ARG.COPY_NB) written by PrepareIndirect.
// Dead slots' neighbor data in nbOut is left stale but is never read (PropagateBisect only
// reads neighbors of alive slots in the propagation list).
//
// Composed after: engineWgslPreamble + terrain_topo_common.wgsl.

@group(0) @binding(3)  var<storage, read>       nbIn        : array<u32>;
@group(0) @binding(4)  var<storage, read_write>  nbOut       : array<u32>;
@group(0) @binding(13) var<storage, read>        activeSlots : array<u32>;
@group(0) @binding(21) var<storage, read>        activeCount : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let i = linear_id(gid, nwg.x);
    if (i >= activeCount[0]) { return; }
    let slot = activeSlots[i];
    let b = slot * NB_WORDS;
    nbOut[b]      = nbIn[b];
    nbOut[b + 1u] = nbIn[b + 1u];
    nbOut[b + 2u] = nbIn[b + 2u];
}
