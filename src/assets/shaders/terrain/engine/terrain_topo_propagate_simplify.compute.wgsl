// OCBT engine — PropagateSimplify pass (one thread per simplify-propagation entry).
// Faithful port of PropagateElementSimplify (update_utilities.hlsl): after a collapse,
// repoint the affected neighbour's references from the deleted pair to the surviving
// (risen) slot. Three cases: neighbour unchanged; neighbour also merged but still
// alive; neighbour merged AND gone (fix its pair instead). In-place on the live buffer.
//
// Composed after: engineWgslPreamble + ocbt_u64.wgsl + common.

@group(0) @binding(2) var<storage, read>       heapID       : array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> neighbors    : array<u32>;
@group(0) @binding(5) var<storage, read_write> bisectorData : array<u32>;
@group(0) @binding(9) var<storage, read_write> propagate    : array<atomic<u32>>;

fn nb(s : u32, k : u32) -> u32 { return neighbors[s * NB_WORDS + k]; }
fn setNb(s : u32, k : u32, v : u32) { neighbors[s * NB_WORDS + k] = v; }
fn bdf(s : u32, f : u32) -> u32 { return bisectorData[s * BD_WORDS + f]; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let listIdx = linear_id(gid, nwg.x);
    if (listIdx >= atomicLoad(&propagate[1])) { return; }
    let currentID = atomicLoad(&propagate[2u + listIdx]);

    let deletedPair = bdf(currentID, BD_PROPAGATION);
    let neighborID = bdf(currentID, BD_PROBLEMATIC);
    if (neighborID == OCBT_INVALID) { return; }

    let nState = bdf(neighborID, BD_STATE);
    if (nState != ST_MERGED) {
        for (var i = 0u; i < 3u; i = i + 1u) {
            if (nb(neighborID, i) == deletedPair) { setNb(neighborID, i, currentID); }
        }
    } else {
        if (!heap_is_zero(heapID[neighborID])) {
            // Neighbour merged but still alive (rose one level).
            for (var i = 0u; i < 3u; i = i + 1u) {
                if (nb(neighborID, i) == deletedPair) { setNb(neighborID, i, currentID); }
            }
        } else {
            // Neighbour was deleted by its own collapse; patch its surviving pair.
            let neighborPair = nb(neighborID, 1u);
            for (var i = 0u; i < 3u; i = i + 1u) {
                if (nb(neighborPair, i) == deletedPair) { setNb(neighborPair, i, currentID); }
            }
        }
    }

    bisectorData[currentID * BD_WORDS + BD_PROBLEMATIC] = OCBT_INVALID;
}
