// TERRAIN engine — Simplify pass (one thread per simplification-list entry). Faithful
// port of SimplifyElement (update_utilities.hlsl): collapse the diamond (currentID +
// its pair across n0) back up one level (heapID/2), and the facing twin-pair if
// present. The kept slots (currentID, twinLowID) survive; the pair + twinHigh are
// freed (heapID=0, pool bit cleared). Neighbors are rewired IN PLACE on the current
// (live) buffer — PrepareSimplify guarantees disjoint, fully-conformant diamonds, so
// no ping-pong is needed (matches the reference). Survivors that touch a changed
// neighbour are appended to the simplify-propagation list.
//
// Atlas tile invalidation: surviving slots (currentID, twinLowID) transition from
// leaf-child to leaf-parent geometry. Their previously-baked normals were computed for
// the finer child triangle and are WRONG for the coarser parent. We reclaim those tiles
// before the heapID shift so mark_stable sees stableFrames=0 next frame and re-queues
// the slot for a fresh bake at the correct parent geometry.
//
// Composed after: engineWgslPreamble + slotStateWgslPreamble + terrain_u64.wgsl +
//   terrain_pool.wgsl + terrain_topo_common.wgsl.
// pool_tree(1) is declared by terrain_pool.wgsl but unused -> stripped (do not bind).

@group(0) @binding(2)  var<storage, read_write> heapID         : array<vec2<u32>>;
@group(0) @binding(3)  var<storage, read_write> neighbors      : array<u32>;
@group(0) @binding(5)  var<storage, read_write> bisectorData   : array<u32>;
@group(0) @binding(7)  var<storage, read_write> simplification : array<atomic<u32>>;
@group(0) @binding(9)  var<storage, read_write> propagate      : array<atomic<u32>>;
@group(0) @binding(22) var<storage, read_write> slotState      : array<u32>;
@group(0) @binding(25) var<storage, read_write> freedTiles     : array<atomic<u32>>;

// Invalidate the atlas tile for a slot transitioning to a coarser geometry level.
// Pushes the old tile back to the GPU free-list and zeros slotState so mark_stable
// treats the slot as brand-new (stableFrames=0) and re-queues it for a fresh bake.
fn reclaimAndResetTile(id: u32) {
    let sw = slotState[id];
    let ti = (sw >> SLOT_TILE_SHIFT) & SLOT_TILE_MASK;
    if (ti != 0u) {
        let pos = atomicAdd(&freedTiles[0], 1u);
        if (pos < ATLAS_TILE_COUNT) {
            atomicStore(&freedTiles[1u + pos], ti);
        }
    }
    slotState[id] = 0u;
}

fn nb(s : u32, k : u32) -> u32 { return neighbors[s * NB_WORDS + k]; }
fn setNb(s : u32, k : u32, v : u32) { neighbors[s * NB_WORDS + k] = v; }
fn setBd(s : u32, prop : u32, problem : u32, state : u32, flags : u32) {
    bisectorData[s * BD_WORDS + BD_PROPAGATION] = prop;
    bisectorData[s * BD_WORDS + BD_PROBLEMATIC] = problem;
    bisectorData[s * BD_WORDS + BD_STATE] = state;
    bisectorData[s * BD_WORDS + BD_FLAGS] = flags;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let listIdx = linear_id(gid, nwg.x);
    if (listIdx >= atomicLoad(&simplification[0])) { return; }
    let currentID = atomicLoad(&simplification[1u + listIdx]);

    let cn2 = nb(currentID, 2u);
    let pairID = nb(currentID, 0u);
    let pn0 = nb(pairID, 0u);
    let pn2 = nb(pairID, 2u);
    let twinLowID = pn0;
    let twinHighID = nb(currentID, 1u);

    // Reclaim child-baked tile before currentID rises to parent level.
    reclaimAndResetTile(currentID);

    // Collapse current + pair: current rises one level, pair is freed.
    heapID[currentID] = u64_shr(heapID[currentID], 1u);
    heapID[pairID] = vec2<u32>(0u, 0u);
    setNb(currentID, 0u, cn2);       // n0 = current's old BASE
    setNb(currentID, 1u, pn2);       // n1 = pair's old BASE
    setNb(currentID, 2u, twinLowID); // n2 = facing twin (or INVALID)
    setBd(currentID, pairID, pn2, ST_MERGED, FLAG_VISIBLE | FLAG_MODIFIED);
    if (pn2 != TERRAIN_INVALID) {
        let loc = atomicAdd(&propagate[1], 1u);
        atomicStore(&propagate[2u + loc], currentID);
    }
    setBd(pairID, TERRAIN_INVALID, TERRAIN_INVALID, ST_MERGED, 0u);
    pool_setBitAtomic(pairID, false);

    // Collapse the facing twin-pair the same way, if present.
    if (twinLowID != TERRAIN_INVALID) {
        let lfn2 = nb(twinLowID, 2u);
        let hfn2 = nb(twinHighID, 2u);

        // Reclaim child-baked tile before twinLowID rises to parent level.
        reclaimAndResetTile(twinLowID);

        heapID[twinLowID] = u64_shr(heapID[twinLowID], 1u);
        heapID[twinHighID] = vec2<u32>(0u, 0u);
        setNb(twinLowID, 0u, lfn2);
        setNb(twinLowID, 1u, hfn2);
        setNb(twinLowID, 2u, currentID);
        setBd(twinLowID, twinHighID, hfn2, ST_MERGED, FLAG_VISIBLE | FLAG_MODIFIED);
        if (hfn2 != TERRAIN_INVALID) {
            let loc = atomicAdd(&propagate[1], 1u);
            atomicStore(&propagate[2u + loc], twinLowID);
        }
        setBd(twinHighID, TERRAIN_INVALID, TERRAIN_INVALID, ST_MERGED, 0u);
        pool_setBitAtomic(twinHighID, false);
    }
}
