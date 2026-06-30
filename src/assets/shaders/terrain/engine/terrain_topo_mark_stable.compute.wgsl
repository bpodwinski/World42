// TERRAIN tile-cache stability tracker — Pass 1: Reclaim + Stability.
// One thread per pool slot (dispatch ceil(CAPACITY/256)).
//
// Updates each slot's SLOT_STATE packed u32 word:
//   dead slot  → reset to 0; push its atlas tile back onto the GPU free-list (freedTiles)
//   new slot   → stableFrames = 1, no tile (Pass 2 pops the tile from freedTiles)
//   live slot  → increment stableFrames (saturate at 0xFFFF); if stable enough and
//                still dirty, append to bake_worklist (capped at MAX_BAKE_PER_FRAME)
//
// freedTiles is a PERSISTENT GPU free-list stack (NOT reset each frame):
//   freedTiles[0]          = current count of free tiles (atomic u32)
//   freedTiles[1..N+1]     = tile indices at stack positions 0..N-1
// The CPU must zero bake_worklist[0] before each dispatch but must NOT touch freedTiles.
//
// Composed after: engineWgslPreamble + slotStateWgslPreamble + terrain_u64.wgsl + terrain_topo_common.wgsl

@group(0) @binding(2)  var<storage, read>       heapID          : array<vec2<u32>>;
@group(0) @binding(22) var<storage, read_write> slotState       : array<u32>;
@group(0) @binding(25) var<storage, read_write> freedTiles      : array<atomic<u32>>;
@group(0) @binding(26) var<storage, read_write> bakeWorklist    : array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups)        nwg : vec3<u32>) {
    let id = linear_id(gid, nwg.x);
    if (id >= TERRAIN_CAPACITY) { return; }

    let alive = !heap_is_zero(heapID[id]);
    let sw    = slotState[id];

    if (!alive) {
        // Reclaim any assigned tile — whether baked (SLOT_HAS_TILE_BIT set) or still
        // dirty (assigned by the alloc pass but not yet baked). Tile 0 is the sentinel
        // "no tile assigned", so a non-zero tile_idx means there is a tile to push back.
        let tileIdx = (sw >> SLOT_TILE_SHIFT) & SLOT_TILE_MASK;
        if (tileIdx != 0u) {
            let writePos = atomicAdd(&freedTiles[0], 1u);
            if (writePos < ATLAS_TILE_COUNT) {
                atomicStore(&freedTiles[1u + writePos], tileIdx);
            }
        }
        slotState[id] = 0u;
        return;
    }

    let stableFrames = sw & SLOT_STABLE_MASK;

    if (stableFrames == 0u) {
        // First frame alive: mark as stable with no tile yet.
        // terrain_topo_mark_stable_alloc (Pass 2) will pop a tile from freedTiles.
        slotState[id] = 1u;
        return;
    }

    let newFrames = min(stableFrames + 1u, 0xFFFFu);
    let preserved = sw & ~SLOT_STABLE_MASK;
    let newState  = preserved | newFrames;

    if (newFrames >= SLOT_BAKE_THRESHOLD && (sw & SLOT_DIRTY_BIT) != 0u) {
        let wslot = atomicAdd(&bakeWorklist[0], 1u);
        if (wslot < MAX_BAKE_PER_FRAME) {
            atomicStore(&bakeWorklist[1u + wslot], id);
        }
    }

    slotState[id] = newState;
}
