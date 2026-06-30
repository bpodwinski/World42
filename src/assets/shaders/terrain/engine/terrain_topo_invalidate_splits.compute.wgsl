// TERRAIN tile-cache — Invalidate splits pass.
// One thread per allocate-list entry (same list that Bisect reads).
//
// When a slot is bisected, the engine REUSES its pool slot as the low child
// (heapID << 1 or << 2). Any atlas tile baked at the parent level has normals
// computed for the coarser geometry and is WRONG for the finer child.
// This pass reclaims those tiles before Bisect mutates the heapIDs, so that
// mark_stable sees stableFrames=0 next frame and re-queues a fresh bake at the
// correct child geometry.
// Freshly-allocated sibling slots (s0, s1, s2) already have slotState=0
// (set when they were last freed) and need no special handling here.
//
// Must run AFTER the Allocate pass (which fills the list) and BEFORE Bisect.
//
// Composed after: engineWgslPreamble + slotStateWgslPreamble + terrain_topo_common.wgsl

@group(0) @binding(8)  var<storage, read_write> allocate   : array<atomic<u32>>;
@group(0) @binding(22) var<storage, read_write> slotState  : array<u32>;
@group(0) @binding(25) var<storage, read_write> freedTiles : array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups)        nwg : vec3<u32>) {
    let listIdx = linear_id(gid, nwg.x);
    if (listIdx >= atomicLoad(&allocate[0])) { return; }
    let currentID = atomicLoad(&allocate[1u + listIdx]);

    let sw = slotState[currentID];
    let ti = (sw >> SLOT_TILE_SHIFT) & SLOT_TILE_MASK;
    if (ti != 0u) {
        let pos = atomicAdd(&freedTiles[0], 1u);
        if (pos < ATLAS_TILE_COUNT) {
            atomicStore(&freedTiles[1u + pos], ti);
        }
    }
    slotState[currentID] = 0u;
}
