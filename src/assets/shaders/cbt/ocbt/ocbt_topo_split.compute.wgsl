// OCBT engine — Split pass (one thread per split-list entry). Faithful port of
// SplitElement (update_utilities.hlsl): yields if driven by a neighbor already on the
// path, reserves the free-slot budget atomically (refunding on over-subscription),
// raises CENTER_SPLIT on itself via atomicOr (the reservation handshake), then walks
// up the longest-edge (BASE/twin) chain raising CENTER on a same-depth twin or
// RIGHT/LEFT_DOUBLE on a coarser twin until the chain terminates. Winners are appended
// to the allocate list. This is the concurrent equivalent of the oracle's LEPP.
//
// Composed after: engineWgslPreamble + ocbt_u64.wgsl + common.
// neighbors = the CURRENT (this-frame) neighbor buffer (read-only here).
// bisectorData is atomic (atomicOr on the pattern field, atomicLoad on state).

@group(0) @binding(2)  var<storage, read>       heapID         : array<vec2<u32>>;
@group(0) @binding(3)  var<storage, read>       neighbors      : array<u32>;
@group(0) @binding(5)  var<storage, read_write> bisectorData   : array<atomic<u32>>;
@group(0) @binding(6)  var<storage, read_write> classification : array<atomic<u32>>;
@group(0) @binding(8)  var<storage, read_write> allocate       : array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> memory         : array<atomic<i32>>;

fn nb_n0(s : u32) -> u32 { return neighbors[s * NB_WORDS + 0u]; }  // reference n0 (LEFT)
fn nb_n1(s : u32) -> u32 { return neighbors[s * NB_WORDS + 1u]; }  // reference n1 (RIGHT)
fn nb_n2(s : u32) -> u32 { return neighbors[s * NB_WORDS + 2u]; }  // reference n2 (TWIN/BASE)
fn bd_state(s : u32) -> u32 { return atomicLoad(&bisectorData[s * BD_WORDS + BD_STATE]); }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let listIdx = linear_id(gid, nwg.x);
    if (listIdx >= atomicLoad(&classification[SPLIT_COUNTER])) { return; }
    var currentID = atomicLoad(&classification[CLASSIFY_COUNTER_OFFSET + listIdx]);

    // Yield if we are on the longest-edge path of a neighbor that drives the diamond:
    // if neighbor X's twin is us AND X is itself changing, X will subdivide us.
    let cn0 = nb_n0(currentID);
    if (cn0 != OCBT_INVALID) {
        if (nb_n2(cn0) == currentID && bd_state(cn0) != ST_UNCHANGED) { return; }
    }
    let cn1 = nb_n1(currentID);
    if (cn1 != OCBT_INVALID) {
        if (nb_n2(cn1) == currentID && bd_state(cn1) != ST_UNCHANGED) { return; }
    }

    let heap = heapID[currentID];
    var currentDepth = u64_depth(heap);

    // Maximal memory this whole forced subdivision could need (reference formula),
    // tightened for the common terminal cases to avoid massive over-reservation.
    var maxReq : i32 = 2 * i32(currentDepth - BASE_DEPTH) - 1;
    var twinID = nb_n2(currentID);
    if (twinID == OCBT_INVALID) {
        maxReq = 1;
    } else if (nb_n2(twinID) == currentID) {
        maxReq = 2;
    }

    // Reserve the budget. atomicSub returns the value BEFORE the subtraction.
    let prevBudget = atomicSub(&memory[1], maxReq);
    if (prevBudget < maxReq) {            // not enough free slots — refund and bail
        atomicAdd(&memory[1], maxReq);
        return;
    }

    var usedMemory : i32 = 1;
    let prevPat = atomicOr(&bisectorData[currentID * BD_WORDS + BD_PATTERN], CENTER_SPLIT);
    if (prevPat != 0u) {                  // another neighbor already drives us
        atomicAdd(&memory[1], maxReq);
        return;
    }

    let loc0 = atomicAdd(&allocate[0], 1u);
    atomicStore(&allocate[1u + loc0], currentID);

    // Walk up the BASE/twin chain.
    var done = false;
    loop {
        if (done) { break; }
        if (twinID == OCBT_INVALID) { break; }

        let nHeap = heapID[twinID];
        let nDepth = u64_depth(nHeap);

        if (nDepth == currentDepth) {
            let p = atomicOr(&bisectorData[twinID * BD_WORDS + BD_PATTERN], CENTER_SPLIT);
            if (p == 0u) {
                let l = atomicAdd(&allocate[0], 1u);
                atomicStore(&allocate[1u + l], twinID);
                usedMemory = usedMemory + 1;
            }
            done = true;
        } else {
            // Twin is coarser: it must double-split to conform.
            var p : u32;
            if (nb_n0(twinID) == currentID) {
                p = atomicOr(&bisectorData[twinID * BD_WORDS + BD_PATTERN], RIGHT_DOUBLE);
            } else { // nb_n1(twinID) == currentID
                p = atomicOr(&bisectorData[twinID * BD_WORDS + BD_PATTERN], LEFT_DOUBLE);
            }
            if (p != 0u) {
                usedMemory = usedMemory + 1;
                done = true;
            } else {
                let l = atomicAdd(&allocate[0], 1u);
                atomicStore(&allocate[1u + l], twinID);
                usedMemory = usedMemory + 2;
                currentID = twinID;
                currentDepth = nDepth;
                twinID = nb_n2(currentID);
            }
        }
    }

    // Refund the slack.
    let slack = maxReq - usedMemory;
    if (slack > 0) { atomicAdd(&memory[1], slack); }
}
