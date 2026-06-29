// TERRAIN engine — Bisect pass (one thread per allocate-list entry). Faithful port of
// BisectElement + evaluate_neighbors (update_utilities.hlsl), adapted to the flat
// buffers. Each winner subdivides per its accumulated pattern (CENTER / RIGHT_DOUBLE /
// LEFT_DOUBLE / TRIPLE), REUSING its own slot as child0 and the freshly-allocated
// indices[] as the other children. Sets child heap ids (u64 2h / 4h+k), writes the new
// topology into the NEXT (ping-pong) neighbor buffer, records parent/propagation data
// for the reciprocity fixup, marks the new pool slots allocated, and appends the
// CENTER/RIGHT_DOUBLE propagation entry.
//
// Composed after: engineWgslPreamble + terrain_u64.wgsl + terrain_pool.wgsl + common.
// neighbors    = CURRENT (this-frame) buffer, read-only (parent neighbors).
// neighborsOut = NEXT (ping-pong) buffer, written here.
// pool_tree(1) is declared by terrain_pool.wgsl but unused here -> stripped (do not bind).

@group(0) @binding(2) var<storage, read_write> heapID       : array<vec2<u32>>;
@group(0) @binding(3) var<storage, read>       neighbors    : array<u32>;
@group(0) @binding(4) var<storage, read_write> neighborsOut : array<u32>;
@group(0) @binding(5) var<storage, read_write> bisectorData : array<u32>;
@group(0) @binding(8) var<storage, read_write> allocate     : array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> propagate    : array<atomic<u32>>;

fn bd_pattern(s : u32) -> u32 { return bisectorData[s * BD_WORDS + BD_PATTERN]; }
fn bd_idx(s : u32, k : u32) -> u32 { return bisectorData[s * BD_WORDS + BD_INDEX0 + k]; }
fn cn(s : u32, k : u32) -> u32 { return neighbors[s * NB_WORDS + k]; }  // current neighbor

fn setNbOut(s : u32, a : u32, b : u32, c : u32) {
    neighborsOut[s * NB_WORDS + 0u] = a;
    neighborsOut[s * NB_WORDS + 1u] = b;
    neighborsOut[s * NB_WORDS + 2u] = c;
}

// Sets the bookkeeping fields the propagation/indexation passes read. Leaves the
// pattern + indices fields untouched (the reused parent slot must keep them; fresh
// children never have them read this frame and Classify clears them next frame).
fn setBd(s : u32, propID : u32, problematic : u32) {
    bisectorData[s * BD_WORDS + BD_PROPAGATION] = propID;
    bisectorData[s * BD_WORDS + BD_PROBLEMATIC] = problematic;
    bisectorData[s * BD_WORDS + BD_FLAGS] = FLAG_VISIBLE | FLAG_MODIFIED;
}

struct Eval { x : u32, y : u32 };

// Port of evaluate_neighbors: which two child slots of `bisectorID` face `currentID`.
fn evaluate_neighbors(currentID : u32, bisectorID : u32) -> Eval {
    var r : Eval;
    r.x = TERRAIN_INVALID;
    r.y = TERRAIN_INVALID;
    let pat = bd_pattern(bisectorID);
    let n0 = cn(bisectorID, 0u);
    let n1 = cn(bisectorID, 1u);
    let i0 = bd_idx(bisectorID, 0u);
    let i1 = bd_idx(bisectorID, 1u);
    let i2 = bd_idx(bisectorID, 2u);
    if (pat == CENTER_SPLIT) {
        r.x = i0;
        r.y = bisectorID;
    } else if (pat == RIGHT_DOUBLE) {
        if (n0 == currentID) { r.x = i1; r.y = bisectorID; }
        else { r.x = i0; r.y = i1; }
    } else if (pat == LEFT_DOUBLE) {
        if (n1 == currentID) { r.x = i1; r.y = i0; }
        else { r.x = i0; r.y = bisectorID; }
    } else { // TRIPLE
        if (n0 == currentID) { r.x = i1; r.y = bisectorID; }
        else if (n1 == currentID) { r.x = i2; r.y = i0; }
        else { r.x = i0; r.y = i1; }
    }
    return r;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let listIdx = linear_id(gid, nwg.x);
    if (listIdx >= atomicLoad(&allocate[0])) { return; }
    let currentID = atomicLoad(&allocate[1u + listIdx]);

    let baseHeap = heapID[currentID];
    let pattern = bd_pattern(currentID);
    if (heap_is_zero(baseHeap) || pattern == NO_SPLIT) { return; }

    let p_n0 = cn(currentID, 0u);
    let p_n1 = cn(currentID, 1u);
    let p_n2 = cn(currentID, 2u);
    let s0 = bd_idx(currentID, 0u);
    let s1 = bd_idx(currentID, 1u);
    let s2 = bd_idx(currentID, 2u);

    // heap ids use the REFERENCE leb convention (faithful port). It differs from
    // World42's terrain_leb by a geometry-dependent per-level bit-swap, so the cross-check
    // decodes GPU heap ids with a reference-convention decoder and compares GEOMETRY,
    // never raw heap-id labels (which only match within one convention).
    if (pattern == CENTER_SPLIT) {
        var ev : Eval;
        ev.x = TERRAIN_INVALID;
        ev.y = TERRAIN_INVALID;
        if (p_n2 != TERRAIN_INVALID) { ev = evaluate_neighbors(currentID, p_n2); }

        heapID[currentID] = heap_2h(baseHeap);
        heapID[s0] = heap_2hp1(baseHeap);

        setNbOut(currentID, s0, ev.x, p_n0);
        setNbOut(s0, ev.y, currentID, p_n1);

        setBd(currentID, currentID, TERRAIN_INVALID);
        setBd(s0, currentID, p_n1);

        let loc = atomicAdd(&propagate[0], 1u);
        atomicStore(&propagate[2u + loc], s0);
    } else if (pattern == RIGHT_DOUBLE) {
        let ev0 = evaluate_neighbors(currentID, p_n0);
        var ev1 : Eval;
        ev1.x = TERRAIN_INVALID;
        ev1.y = TERRAIN_INVALID;
        if (p_n2 != TERRAIN_INVALID) { ev1 = evaluate_neighbors(currentID, p_n2); }

        heapID[currentID] = heap_4h(baseHeap);
        heapID[s0] = heap_2hp1(baseHeap);
        heapID[s1] = heap_4hpk(baseHeap, 1u);

        setNbOut(currentID, s1, ev0.x, s0);
        setNbOut(s0, ev1.y, currentID, p_n1);
        setNbOut(s1, ev0.y, currentID, ev1.x);

        setBd(currentID, currentID, TERRAIN_INVALID);
        setBd(s0, currentID, p_n1);
        setBd(s1, currentID, TERRAIN_INVALID);

        let loc = atomicAdd(&propagate[0], 1u);
        atomicStore(&propagate[2u + loc], s0);
    } else if (pattern == LEFT_DOUBLE) {
        let ev0 = evaluate_neighbors(currentID, p_n1);
        var ev1 : Eval;
        ev1.x = TERRAIN_INVALID;
        ev1.y = TERRAIN_INVALID;
        if (p_n2 != TERRAIN_INVALID) { ev1 = evaluate_neighbors(currentID, p_n2); }

        heapID[currentID] = heap_2h(baseHeap);
        heapID[s0] = heap_4hpk(baseHeap, 2u);
        heapID[s1] = heap_4hpk(baseHeap, 3u);

        setNbOut(currentID, s1, ev1.x, p_n0);
        setNbOut(s0, s1, ev0.x, ev1.y);
        setNbOut(s1, ev0.y, s0, currentID);

        setBd(currentID, currentID, TERRAIN_INVALID);
        setBd(s0, currentID, TERRAIN_INVALID);
        setBd(s1, currentID, TERRAIN_INVALID);
        // LEFT_DOUBLE emits no propagation entry (reference).
    } else { // TRIPLE
        let ev0 = evaluate_neighbors(currentID, p_n0);
        let ev1 = evaluate_neighbors(currentID, p_n1);
        var ev2 : Eval;
        ev2.x = TERRAIN_INVALID;
        ev2.y = TERRAIN_INVALID;
        if (p_n2 != TERRAIN_INVALID) { ev2 = evaluate_neighbors(currentID, p_n2); }

        heapID[currentID] = heap_4h(baseHeap);
        heapID[s0] = heap_4hpk(baseHeap, 2u);
        heapID[s1] = heap_4hpk(baseHeap, 1u);
        heapID[s2] = heap_4hpk(baseHeap, 3u);

        setNbOut(currentID, s1, ev0.x, s2);
        setNbOut(s0, s2, ev1.x, ev2.y);
        setNbOut(s1, ev0.y, currentID, ev2.x);
        setNbOut(s2, ev1.y, s0, currentID);

        setBd(currentID, currentID, TERRAIN_INVALID);
        setBd(s0, currentID, TERRAIN_INVALID);
        setBd(s1, currentID, TERRAIN_INVALID);
        setBd(s2, currentID, TERRAIN_INVALID);
        // TRIPLE emits no propagation entry (reference).
    }

    // Mark every newly-used pool slot allocated (the reused parent bit stays set).
    let n = countOneBits(pattern);
    for (var k = 0u; k < n; k = k + 1u) {
        pool_setBitAtomic(bd_idx(currentID, k), true);
    }
}
