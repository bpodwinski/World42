// TERRAIN engine — PrepareSimplify pass (one thread per simplify-list entry). Faithful
// port of PrepareSimplifyElement (update_utilities.hlsl): for each even-heap-id
// simplify candidate, verify its full collapse neighbourhood (the pair across n0 and,
// if present, the facing twin-pair) are all SIMPLIFY at the SAME depth and that this
// candidate owns the collapse (lowest heap id of the twin-pair). Survivors are appended
// to the simplification list for the Simplify pass.
//
// Composed after: engineWgslPreamble + terrain_u64.wgsl + common.
// Reads the CURRENT (live) neighbor buffer. bisectorData read-only here.

@group(0) @binding(2)  var<storage, read>       heapID         : array<vec2<u32>>;
@group(0) @binding(3)  var<storage, read>       neighbors      : array<u32>;
@group(0) @binding(5)  var<storage, read>       bisectorData   : array<u32>;
@group(0) @binding(6)  var<storage, read_write> classification : array<atomic<u32>>;
@group(0) @binding(7)  var<storage, read_write> simplification : array<atomic<u32>>;

fn nb(s : u32, k : u32) -> u32 { return neighbors[s * NB_WORDS + k]; }
fn st(s : u32) -> u32 { return bisectorData[s * BD_WORDS + BD_STATE]; }

// True if any neighbor of `s` is FINER (deeper) than depth `d`. Such a leaf is
// conformity-required (a deeper neighbor forced it to this level via the LEPP cascade):
// collapsing it would leave a 2-level seam, so the split pass would immediately re-split
// it. Without this guard the metric-driven merge keeps removing these cascade leaves and
// the split pass keeps re-creating them -> a per-frame split/merge LIMIT CYCLE (leaf set
// flips every frame: debug-LOD checkerboard flicker, terrain shimmer while moving). Refusing
// the merge here is conservative (it only PREVENTS merges, never enables a bad one, so it
// cannot crack the mesh); real coarsening still proceeds coarse-edge-first as neighbors merge.
fn anyFinerNeighbor(s : u32, d : u32) -> bool {
    for (var k = 0u; k < 3u; k = k + 1u) {
        let n = nb(s, k);
        if (n != TERRAIN_INVALID && u64_depth(heapID[n]) > d) { return true; }
    }
    return false;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let listIdx = linear_id(gid, nwg.x);
    if (listIdx >= atomicLoad(&classification[SIMPLIFY_COUNTER])) { return; }
    let currentID = atomicLoad(&classification[CLASSIFY_COUNTER_OFFSET + TERRAIN_CAPACITY + listIdx]);

    let cHeap = heapID[currentID];
    let currentDepth = u64_depth(cHeap);

    let pairID = nb(currentID, 0u);          // n0 = the sibling pair
    let pairDepth = u64_depth(heapID[pairID]);
    if (pairDepth != currentDepth || st(pairID) != ST_SIMPLIFY) { return; }

    let twinLowID = nb(pairID, 0u);          // pair's n0
    let twinHighID = nb(currentID, 1u);      // current's n1
    if (twinLowID != TERRAIN_INVALID) {
        let twinLowHeap = heapID[twinLowID];
        // The smaller heap id of the facing twin-pair owns the collapse.
        if (u64_gt(cHeap, twinLowHeap)) { return; }
        let lowD = u64_depth(twinLowHeap);
        let highD = u64_depth(heapID[twinHighID]);
        if (lowD != currentDepth || highD != currentDepth) { return; }
        if (st(twinLowID) != ST_SIMPLIFY || st(twinHighID) != ST_SIMPLIFY) { return; }
    }

    // Conformity guard: refuse if any diamond member still has a finer neighbor (else the
    // split pass re-splits it next frame -> the split/merge limit cycle / flicker).
    if (anyFinerNeighbor(currentID, currentDepth) || anyFinerNeighbor(pairID, currentDepth)) { return; }
    if (twinLowID != TERRAIN_INVALID) {
        if (anyFinerNeighbor(twinLowID, currentDepth) || anyFinerNeighbor(twinHighID, currentDepth)) { return; }
    }

    let loc = atomicAdd(&simplification[0], 1u);
    atomicStore(&simplification[1u + loc], currentID);
}
