// TERRAIN tile-cache tile allocator — Pass 2: Alloc.
// One thread per pool slot (dispatch ceil(CAPACITY/256)).
// Runs immediately after terrain_topo_mark_stable (Pass 1). The Babylon.js dispatch
// boundary acts as an implicit memory barrier so Pass 1's writes to slotState and
// freedTiles are visible here.
//
// For every alive slot that does not yet have an atlas tile, pops one tile index from
// the GPU free-list (freedTiles) and assigns it. The free-list is a persistent LIFO
// stack shared with Pass 1 (which pushes tiles from dead slots):
//   freedTiles[0]          = current count of free tiles (atomic u32)
//   freedTiles[1..N+1]     = tile indices at stack positions 0..N-1
//   pop: oldCount = atomicSub(&freedTiles[0], 1u); tileIdx = freedTiles[oldCount]
//
// A bounds check on oldCount handles the race where multiple threads attempt to pop
// from an empty stack: any value > ATLAS_TILE_COUNT signals a u32 underflow caused by
// a concurrent pop, and the decrement is undone.
//
// Composed after: engineWgslPreamble + slotStateWgslPreamble + terrain_u64.wgsl + terrain_topo_common.wgsl

@group(0) @binding(22) var<storage, read_write> slotState  : array<u32>;
@group(0) @binding(25) var<storage, read_write> freedTiles : array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups)        nwg : vec3<u32>) {
    let id = linear_id(gid, nwg.x);
    if (id >= TERRAIN_CAPACITY) { return; }

    let sw = slotState[id];

    // Skip dead slots (stableFrames == 0) and slots that already have a tile assigned.
    // Use tile_idx > 0 as the sentinel: tile 0 is reserved as "no tile", so valid tiles
    // are 1..ATLAS_TILE_COUNT-1. This lets the dead-slot reclaim path in Pass 1 push back
    // tiles that were assigned but not yet baked (SLOT_HAS_TILE_BIT not yet set by bake).
    if ((sw & SLOT_STABLE_MASK) == 0u) { return; }
    if ((sw >> SLOT_TILE_SHIFT) != 0u) { return; }

    // Atomically pop one tile from the free-list (LIFO).
    // atomicSub returns the value BEFORE the decrement, which is the buffer index to read.
    let oldCount = atomicSub(&freedTiles[0], 1u);

    // Empty pool: oldCount == 0 means the list was already empty.
    // Underflow race: oldCount > ATLAS_TILE_COUNT means another thread decremented first
    // and the u32 counter wrapped around. Both cases: undo and leave slot without a tile.
    if (oldCount == 0u || oldCount > ATLAS_TILE_COUNT) {
        atomicAdd(&freedTiles[0], 1u);
        return;
    }

    // Each concurrent pop gets a unique oldCount (atomicSub is globally serialized), so
    // freedTiles[oldCount] is read by exactly this thread — no collision possible.
    let tileIdx = atomicLoad(&freedTiles[oldCount]);

    // Assign the tile: preserve stableFrames; mark dirty (needs baking).
    // Do NOT set SLOT_HAS_TILE_BIT here — the bake shader sets it once the tile is
    // fully written. The fragment shader only samples when SLOT_HAS_TILE_BIT is set,
    // so it will not read stale/uninitialised texels from a recycled tile slot.
    let stableFrames = sw & SLOT_STABLE_MASK;
    slotState[id] = stableFrames | SLOT_DIRTY_BIT | (tileIdx << SLOT_TILE_SHIFT);
}
