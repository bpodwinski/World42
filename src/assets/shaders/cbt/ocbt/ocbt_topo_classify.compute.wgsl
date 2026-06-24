// OCBT engine — Classify pass (one thread per pool slot). Port of ClassifyElement
// (update_utilities.hlsl) with the camera/geometry metric REPLACED by a deterministic,
// CONVENTION-INVARIANT per-face target-level predicate: refine a leaf while its level
// (depth-3) is below its octahedron face's target level. The face is the top heap bits
// (heap >> (depth-3) = 8..15), identical in the reference and ocbt_leb conventions, so
// the concurrent GPU and the sequential CPU oracle refine the SAME geometric regions
// and converge to the same conforming mesh — without depending on the (differing)
// path-bit labeling. Resets each live slot's per-frame BisectorData fields and appends
// BISECT candidates to the classification split list. Simplify (merge) is out of scope.
//
// Composed after: engineWgslPreamble + ocbt_u64.wgsl + common.
//
// faceTarget layout: 8 u32, faceTarget[f] = target LEVEL (depth-3) for face f (0..7).

@group(0) @binding(2)  var<storage, read>       heapID         : array<vec2<u32>>;
@group(0) @binding(5)  var<storage, read_write> bisectorData   : array<u32>;
@group(0) @binding(6)  var<storage, read_write> classification : array<atomic<u32>>;
@group(0) @binding(18) var<storage, read>       faceTarget     : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let id = linear_id(gid, nwg.x);
    if (id >= OCBT_CAPACITY) { return; }

    let heap = heapID[id];
    if (heap_is_zero(heap)) { return; }      // dead slot
    let depth = u64_depth(heap);

    // Reset per-frame fields (this thread owns its slot, so plain stores are correct).
    let b = id * BD_WORDS;
    bisectorData[b + BD_PATTERN]     = NO_SPLIT;
    bisectorData[b + BD_STATE]       = ST_UNCHANGED;
    bisectorData[b + BD_PROBLEMATIC] = OCBT_INVALID;
    bisectorData[b + BD_FLAGS]       = FLAG_VISIBLE;

    // Compare this leaf's level to its face's target: below => split, above => simplify.
    let level = depth - BASE_DEPTH;
    let faceNode = u64_shr(heap, level); // = 8 + face (the depth-3 ancestor)
    let face = faceNode.x - 8u;          // 0..7
    let tgt = faceTarget[face];

    if (level < tgt) {
        bisectorData[b + BD_STATE] = ST_BISECT;
        let slot = atomicAdd(&classification[SPLIT_COUNTER], 1u);
        atomicStore(&classification[CLASSIFY_COUNTER_OFFSET + slot], id);
    } else if (level > tgt) {
        // Wants to be coarser. Mark ALL such leaves SIMPLIFY (the merge passes inspect
        // the whole diamond's state), but only register the EVEN heap ids — the odd
        // partner is collapsed by its even pair (reference ClassifyElement).
        bisectorData[b + BD_STATE] = ST_SIMPLIFY;
        if (u64_bit(heap, 0u) == 0u) {
            let slot = atomicAdd(&classification[SIMPLIFY_COUNTER], 1u);
            atomicStore(&classification[CLASSIFY_COUNTER_OFFSET + OCBT_CAPACITY + slot], id);
        }
    }
}
