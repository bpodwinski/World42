// TERRAIN tile-cache — coarse-mip reduce pass.
// One workgroup per re-baked tile (z = bake-worklist index); 8×8 threads = the 8×8 coarse
// texels. Each thread averages its 8×8 block of the 64×64 mip0 tile and writes one coarse
// texel — the ×8 downsample ("mip 3") the fragment blends toward at distance so the cache
// stays grain-free under minification (no hardware mips, no inter-tile bleed).
//
// Must run AFTER the bake pass (it reads the mip0 tiles the bake just wrote) over the SAME
// worklist, so coarse and mip0 stay in sync per tile.
//
// Composed after: engineWgslPreamble + slotStateWgslPreamble (supplies SLOT_*/ATLAS_*/COARSE_*).

@group(0) @binding(22) var<storage, read> slotState    : array<u32>;
@group(0) @binding(23) var               srcNormal     : texture_2d<f32>;
@group(0) @binding(24) var               srcAlbedo     : texture_2d<f32>;
@group(0) @binding(26) var<storage, read> bakeWorklist : array<u32>;
@group(0) @binding(27) var               coarseNormal  : texture_storage_2d<rgba16float, write>;
@group(0) @binding(28) var               coarseAlbedo  : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(workgroup_id) wgid : vec3<u32>,
        @builtin(local_invocation_id) lid : vec3<u32>) {
    let z = wgid.z;
    if (z >= bakeWorklist[0]) { return; }
    let slot    = bakeWorklist[1u + z];
    let tileIdx = (slotState[slot] >> SLOT_TILE_SHIFT) & SLOT_TILE_MASK;

    let mip0Org = vec2<u32>((tileIdx % ATLAS_TILES_PER_ROW) * ATLAS_TILE_SIZE,
                            (tileIdx / ATLAS_TILES_PER_ROW) * ATLAS_TILE_SIZE);
    let coarseOrg = vec2<u32>((tileIdx % COARSE_TILES_PER_ROW) * COARSE_TILE_SIZE,
                              (tileIdx / COARSE_TILES_PER_ROW) * COARSE_TILE_SIZE);

    // This thread owns coarse texel (lid.x, lid.y) = the average of the 8×8 mip0 block
    // at [lid*8 .. lid*8+8). The averaged normal is no longer unit length — the fragment
    // renormalizes after the LOD blend (it already does for mip0).
    let block = vec2<u32>(lid.x * 8u, lid.y * 8u);
    var sn = vec4<f32>(0.0);
    var sa = vec4<f32>(0.0);
    for (var j = 0u; j < 8u; j = j + 1u) {
        for (var i = 0u; i < 8u; i = i + 1u) {
            let p = vec2<i32>(mip0Org + block + vec2<u32>(i, j));
            sn = sn + textureLoad(srcNormal, p, 0);
            sa = sa + textureLoad(srcAlbedo, p, 0);
        }
    }
    let inv   = 1.0 / 64.0;
    let coord = vec2<i32>(coarseOrg + lid.xy);
    textureStore(coarseNormal, coord, sn * inv);
    textureStore(coarseAlbedo, coord, sa * inv);
}
