// TERRAIN tile-cache bake pass. For each stable slot in the bake_worklist, evaluates
// the terrain noise at every texel of the slot's 64×64 atlas tile and writes the
// result to normalAtlas (rgba16float, XY encoded) and albedoAtlas (rgba8unorm).
//
// This amortizes the 24+ simplex evaluations that the fragment shader would otherwise
// run per pixel per frame: stable tiles are baked once, then sampled in O(1) per pixel.
//
// Dispatch: (8, 8, MAX_BAKE_PER_FRAME) — 64 workgroups of 64 threads cover one 64×64
// tile. Each Z group handles one slot from bakeWorklist[wgid.z + 1]. Groups where
// wgid.z >= bakeWorklist[0] (no more tiles) exit immediately.
//
// Composed after: engineWgslPreamble + slotStateWgslPreamble + bakedHeader +
//   terrain_noise.wgsl + terrain_f64.wgsl + terrain_noise_df64.wgsl

@group(0) @binding(17) var<uniform>              bakeParams   : vec4<f32>;
// bakeParams.x = camDistKm (camera altitude above surface, for octave fading)
// bakeParams.y = radius km (matches TERRAIN_RADIUS)

@group(0) @binding(19) var<storage, read>        positions    : array<f32>;
// metric positions: 18 f32/slot — 3 corners × (relative.xyz + dir.xyz)
// dir for corner i: positions[slot*18 + i*6 + 3..5]

@group(0) @binding(21) var<storage, read>        terrainPerm  : array<u32>;
@group(0) @binding(22) var<storage, read_write>  slotState    : array<u32>;
@group(0) @binding(23) var                       normalAtlas  : texture_storage_2d<rgba16float, write>;
@group(0) @binding(24) var                       albedoAtlas  : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(26) var<storage, read>        bakeWorklist : array<u32>;

// Procedural albedo splatting — mirrors terrainGroundAlbedo() from terrain_render_material.ts.
// Uses TERRAIN_SLOPE_LO/HI, TERRAIN_REGOLITH, TERRAIN_ROCK, TERRAIN_ALT_LO/HI,
// TERRAIN_HIGHLAND_TINT from bakedHeader(), all baked at shader compile time.
fn terrainGroundAlbedo(slope01 : f32, altKm : f32) -> vec3<f32> {
    let rockW = smoothstep(TERRAIN_SLOPE_LO, TERRAIN_SLOPE_HI, slope01);
    var base = mix(TERRAIN_REGOLITH, TERRAIN_ROCK, rockW);
    let highW = smoothstep(TERRAIN_ALT_LO, TERRAIN_ALT_HI, altKm);
    base = mix(base, base * TERRAIN_HIGHLAND_TINT, highW);
    return base;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(workgroup_id)          wgid : vec3<u32>) {
    let tileZ = wgid.z;
    let count = bakeWorklist[0];
    if (tileZ >= count) { return; }

    let slot     = bakeWorklist[tileZ + 1u];
    let sw       = slotState[slot];
    let tileIdx  = (sw >> SLOT_TILE_SHIFT) & SLOT_TILE_MASK;

    // Texel within the 64×64 tile.
    let tx = gid.x;
    let ty = gid.y;

    // Barycentric coordinates mapped over a unit-right triangle:
    //   corner 0 at (tx=0,  ty=0)  → bary = (1, 0, 0)
    //   corner 1 at (tx=63, ty=0)  → bary = (0, 1, 0)
    //   corner 2 at (tx=0,  ty=63) → bary = (0, 0, 1)
    // Texels outside the triangle (tx+ty > 63) are projected onto the hypotenuse.
    var u = f32(tx) / 63.0;
    var v = f32(ty) / 63.0;
    let w = 1.0 - u - v;
    if (w < 0.0) {
        let s = u + v;
        u = u / s;
        v = v / s;
    }
    let bw = max(1.0 - u - v, 0.0);

    // Read corner directions from the positions buffer (metric layout: 18 f32/slot).
    let base = slot * 18u;
    let c0 = vec3<f32>(positions[base + 3u],  positions[base + 4u],  positions[base + 5u]);
    let c1 = vec3<f32>(positions[base + 9u],  positions[base + 10u], positions[base + 11u]);
    let c2 = vec3<f32>(positions[base + 15u], positions[base + 16u], positions[base + 17u]);
    let dir = normalize(bw * c0 + u * c1 + v * c2);

    let camDistKm = bakeParams.x;
    let radiusKm  = bakeParams.y;

    // Tile-native footprint: a 64×64 tile resolves the triangle at edge/63 km per texel.
    // Fade fbm octaves finer than this so the baked tile is anti-aliased at its OWN
    // resolution and matches the live path's footprint-faded fbm — baking footprintKm=0
    // (full detail) instead leaves high-frequency grain that the live neighbours fade,
    // making baked triangles read as a distinct, grainier facet.
    let e0 = length(c1 - c0);
    let e1 = length(c2 - c0);
    let e2 = length(c2 - c1);
    let texelFpKm = max(e0, max(e1, e2)) * radiusKm / 63.0;

    // Evaluate crater gradient per texel (low-frequency, but needed for correct normals).
    let cf = craterField(dir, radiusKm, camDistKm, true, 0.0);

    // Evaluate fbm gradient (macro + detail octaves, faded to the tile texel footprint).
    let fbmGrad = terrainFbmGradAt_core(dir, camDistKm, radiusKm, texelFpKm, false);

    // Reconstruct surface normal from the combined gradient.
    let nLocal = terrainNormalFromGrad(dir, TERRAIN_RADIUS, fbmGrad + cf.yzw);

    // Slope for albedo splatting (reuse the crater+fbm normal as the landform normal).
    let slope01 = clamp(1.0 - dot(nLocal, dir), 0.0, 1.0);
    let altKm   = radiusKm - radiusKm; // 0.0 — surface point is on the sphere

    // Albedo: base splat + plains brightness variation.
    var albedo = terrainGroundAlbedo(slope01, altKm);
    albedo = albedo * (1.0 + TERRAIN_PLAINS_AMP * terrainSimplex3_d(dir * TERRAIN_PLAINS_FREQ).x);
    let ray = craterRays(dir, radiusKm, camDistKm);
    // Pack ray brightness into alpha channel (reused in fragment for the crater-ray term).
    albedo = clamp(albedo, vec3<f32>(0.0), vec3<f32>(1.0));

    // Atlas tile origin in the 8192×8192 texture.
    let tileRow = tileIdx / ATLAS_TILES_PER_ROW;
    let tileCol = tileIdx % ATLAS_TILES_PER_ROW;
    let origin  = vec2<u32>(tileCol * ATLAS_TILE_SIZE, tileRow * ATLAS_TILE_SIZE);
    let coord   = origin + vec2<u32>(tx, ty);

    // Write the full planet-local normal (XYZ in RGB). nLocal points radially along
    // `dir`, so its Z spans [-1, 1] across the quad-sphere — storing only XY and
    // reconstructing Z = sqrt(1 - x² - y²) (always ≥ 0) would flip/clamp the normal on
    // the -Z hemisphere and anywhere noise drives Z near zero. The atlas is rgba16float,
    // so the B channel is free; keep all three components.
    textureStore(normalAtlas, coord, vec4<f32>(nLocal, 0.0));

    // Write albedo (RGB) + ray brightness (A).
    textureStore(albedoAtlas, coord, vec4<f32>(albedo, ray));

    // Thread (0, 0) of the first workgroup for this tile (gid.x=0, gid.y=0, wgid.z=tileZ)
    // clears DIRTY and sets HAS_TILE. Safe: the fragment only reads slotState NEXT frame,
    // after this dispatch fully completes (WebGPU compute→render barrier).
    if (gid.x == 0u && gid.y == 0u) {
        let newState = (sw & ~SLOT_DIRTY_BIT) | SLOT_HAS_TILE_BIT;
        slotState[slot] = newState;
    }
}
