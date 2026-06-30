// TERRAIN PrepareIndirect (one thread). Reads the per-frame GPU work-list COUNTS and
// writes dispatchIndirect workgroup args (ceil(count/256), with a 2D spill past 65535)
// for all work-list passes, so each dispatches over its candidate count instead of
// the full pool capacity. Modeled on terrain_dispatch_args.compute.wgsl. Dispatched several
// times per frame (after each producer finalizes a count); each call rewrites ALL records
// from the current counts, but a record is only CONSUMED after its producer ran.
//
// args buffer = 10 records x 4 u32 (16 bytes each); dispatchIndirect reads [0..2] = X/Y/Z,
// [3] is padding. Consumers read the X workgroup count via @builtin(num_workgroups).x, so
// the 2D spill stays self-consistent. The in-shader `if (i >= count) return;` guard in
// every consumer MUST stay (ceil rounds the dispatch up to a multiple of 256).
//
// Record layout (byteOffset = record*16):
//   0 Split             <- classification[0] (SPLIT_COUNTER)
//   1 Allocate          <- allocate[0]
//   2 Bisect            <- allocate[0]
//   3 PropagateBisect   <- propagate[0]
//   4 PrepareSimplify   <- classification[1] (SIMPLIFY_COUNTER)
//   5 Simplify          <- simplification[0]
//   6 PropagateSimplify <- propagate[1]
//   7 EvalLeb           <- drawCount[0] (written by PrepareEvalLeb after compact; see that shader)
//   8 Classify          <- drawCount[0]  O(active) classify dispatch
//   9 CopyNeighbors     <- drawCount[0]  O(active) copy-neighbors dispatch
//
// Composed after: engineWgslPreamble (unused consts, harmless).
// Note: binding 21 (drawCount) is only wired in metric+indirect mode (see terrain_topology_kernel.ts).

@group(0) @binding(6)  var<storage, read>       classification : array<u32>;
@group(0) @binding(7)  var<storage, read>       simplification : array<u32>;
@group(0) @binding(8)  var<storage, read>       allocate       : array<u32>;
@group(0) @binding(9)  var<storage, read>       propagate      : array<u32>;
@group(0) @binding(11) var<storage, read_write> args           : array<u32>;
@group(0) @binding(21) var<storage, read>       drawCount      : array<u32>;

const WG : u32 = 256u;
const MAX_DIM : u32 = 65535u;

fn write_rec(rec : u32, count : u32) {
    // Ceil-divide, floored at 1 so a zero count still dispatches one harmless group
    // (its threads all early-out on the consumer's `i >= count` guard).
    let groups = max(1u, (count + WG - 1u) / WG);
    let gy = (groups + MAX_DIM - 1u) / MAX_DIM;
    let gx = (groups + gy - 1u) / gy;
    let b = rec * 4u;
    args[b + 0u] = gx;
    args[b + 1u] = gy;
    args[b + 2u] = 1u;
    args[b + 3u] = 0u;
}

@compute @workgroup_size(1)
fn main() {
    write_rec(0u, classification[0]); // Split             (SPLIT_COUNTER)
    write_rec(1u, allocate[0]);       // Allocate
    write_rec(2u, allocate[0]);       // Bisect
    write_rec(3u, propagate[0]);      // PropagateBisect
    write_rec(4u, classification[1]); // PrepareSimplify   (SIMPLIFY_COUNTER)
    write_rec(5u, simplification[0]); // Simplify
    write_rec(6u, propagate[1]);      // PropagateSimplify
    // Records 7–9 use drawCount[0] (alive-slot count from the last compact).
    // Record 7 (EvalLeb) is also written by PrepareEvalLeb immediately after compact
    // for tighter timing; this write is a secondary update when PrepareIndirect fires.
    write_rec(7u, drawCount[0]);      // EvalLeb           O(active)
    write_rec(8u, drawCount[0]);      // Classify          O(active)
    write_rec(9u, drawCount[0]);      // CopyNeighbors     O(active)
}
