// TERRAIN engine — PropagateBisect pass (one thread per propagate-list entry). Faithful
// port of PropagateBisectElement (update_utilities.hlsl): restores neighbor
// reciprocity for the freshly-created siblings whose split-edge partner referenced the
// pre-split parent. Runs AFTER the ping-pong swap, so `neighbors` here is the NEXT
// (now current) buffer holding the new topology written by CopyNeighbors + Bisect.
//
// Composed after: engineWgslPreamble + terrain_u64.wgsl + common.

@group(0) @binding(3) var<storage, read_write> neighbors    : array<u32>;
@group(0) @binding(5) var<storage, read_write> bisectorData : array<u32>;
@group(0) @binding(9) var<storage, read_write> propagate    : array<atomic<u32>>;

fn nbget(s : u32, k : u32) -> u32 { return neighbors[s * NB_WORDS + k]; }
fn nbset(s : u32, k : u32, v : u32) { neighbors[s * NB_WORDS + k] = v; }
fn bdf(s : u32, f : u32) -> u32 { return bisectorData[s * BD_WORDS + f]; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let listIdx = linear_id(gid, nwg.x);
    if (listIdx >= atomicLoad(&propagate[0])) { return; }
    let currentID = atomicLoad(&propagate[2u + listIdx]);

    let parentID = bdf(currentID, BD_PROPAGATION);
    let problematic = bdf(currentID, BD_PROBLEMATIC);
    if (problematic == TERRAIN_INVALID) { return; }

    let tPattern = bdf(problematic, BD_PATTERN);
    let tgt = problematic;
    let sibling1 = bdf(problematic, BD_INDEX1);

    // Snapshot the target's three lanes (reference reads tNeighbors before patching).
    let t0 = nbget(tgt, 0u);
    let t1 = nbget(tgt, 1u);
    let t2 = nbget(tgt, 2u);

    if (tPattern == NO_SPLIT) {
        if (t0 == parentID) { nbset(tgt, 0u, currentID); }
        if (t1 == parentID) { nbset(tgt, 1u, currentID); }
        if (t2 == parentID) { nbset(tgt, 2u, currentID); }
    } else if (tPattern == CENTER_SPLIT) {
        if (nbget(tgt, 2u) == parentID) { nbset(tgt, 2u, currentID); }
        let tp = bdf(problematic, BD_PROPAGATION);
        if (nbget(tp, 2u) == parentID) { nbset(tp, 2u, currentID); }
    } else if (tPattern == RIGHT_DOUBLE) {
        nbset(sibling1, 2u, currentID);
    } else if (tPattern == LEFT_DOUBLE) {
        nbset(tgt, 2u, currentID);
    }

    bisectorData[currentID * BD_WORDS + BD_PROBLEMATIC] = TERRAIN_INVALID;
    bisectorData[currentID * BD_WORDS + BD_STATE] = ST_UNCHANGED;
}
