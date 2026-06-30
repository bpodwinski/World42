// TERRAIN PrepareEvalLeb (one thread). Reads the current draw count and writes the
// indirect-dispatch workgroup args for the active-list EvalLeb pass (record 7 in
// the shared indirectArgs buffer). Called once at the end of each compact so the
// NEXT frame's evalLebActive dispatches over the just-built active list.
//
// Record 7 layout (byteOffset = 7*16 = 112):
//   args[28] = gx, args[29] = gy, args[30] = 1 (z), args[31] = 0 (pad)
//
// Composed after: engineWgslPreamble (constants unused, harmless).

@group(0) @binding(11) var<storage, read_write> args      : array<u32>;
@group(0) @binding(21) var<storage, read>        drawCount : array<u32>;

const WG      : u32 = 256u;
const MAX_DIM : u32 = 65535u;

@compute @workgroup_size(1)
fn main() {
    let count  = drawCount[0];
    let groups = max(1u, (count + WG - 1u) / WG);
    let gy = (groups + MAX_DIM - 1u) / MAX_DIM;
    let gx = (groups + gy - 1u) / gy;
    let b = 7u * 4u; // record 7 = byte offset 112 / 4 = u32 index 28
    args[b + 0u] = gx;
    args[b + 1u] = gy;
    args[b + 2u] = 1u;
    args[b + 3u] = 0u;
}
