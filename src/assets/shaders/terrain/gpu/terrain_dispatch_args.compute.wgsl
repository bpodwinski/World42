// TERRAIN indirect-dispatch argument builder (Phase 3b/5). One thread. Reads the live
// leaf count (heap root) and writes the workgroup count for the adaptive update
// pass, so the update dispatches over the LIVE leaf count instead of 2^maxDepth.
//
// Composed after: const TERRAIN_MAX_DEPTH, a read-only heap var decl at binding 0, and
// terrain_heap_ro.wgsl (which provides terrain_nodeCount). No semicolons inside line
// comments anywhere in this file (Babylon WGSL preprocessor limitation).
//
// args layout (3 consecutive u32 consumed by dispatchIndirect, X/Y/Z):
//   args[0] = workgroupCountX = ceil(liveLeafCount / 256)
//   args[1] = 1
//   args[2] = 1
@group(0) @binding(1) var<storage, read_write> terrainDispatchArgs : array<u32>;

const TERRAIN_UPDATE_WG_SIZE : u32 = 256u;

@compute @workgroup_size(1)
fn main() {
    let count = terrain_nodeCount();
    // Ceil-divide, floored at 1 so a momentarily-zero root still dispatches one
    // (harmless) group whose threads all early-out on the in-shader guard.
    let groups = max(1u, (count + TERRAIN_UPDATE_WG_SIZE - 1u) / TERRAIN_UPDATE_WG_SIZE);
    // Cap X at the WebGPU per-dimension workgroup limit (65535) and spill into Y.
    // The update shader reconstructs the linear handle from the 2D grid.
    let maxDim = 65535u;
    let gy = (groups + maxDim - 1u) / maxDim;
    let gx = (groups + gy - 1u) / gy;
    terrainDispatchArgs[0] = gx;
    terrainDispatchArgs[1] = gy;
    terrainDispatchArgs[2] = 1u;
}
