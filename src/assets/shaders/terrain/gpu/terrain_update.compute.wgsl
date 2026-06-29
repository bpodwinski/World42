// TERRAIN adaptive update — one dispatch per frame, one thread per leaf. Computes the
// screen-space metric (projected triangle area, mirroring terrain_classify.ts) and
// either splits (too coarse) or merges (too fine). Split and merge alternate by
// frame parity so the bitfield writes never race, and every thread decodes from
// the heap SUM tree (stable within the pass — sums are rebuilt by the separate
// reduction), so every thread sees a consistent snapshot.
//
// Phase 3b: split/merge are forced-diamond CONFORMING (terrain_conform.wgsl), so the
// mesh is watertight WITHIN each octahedron face (no intra-face T-junctions). The
// 12 cross-face seams still need a neighbor remap (next step). Split candidates on
// the far hemisphere are backside-culled (conforming/forced splits from
// front-facing neighbors still reach them, so culling never opens a crack).
//
// Composed after `const TERRAIN_MAX_DEPTH`, terrain_heap_rw.wgsl (binding 0),
// terrain_leb.wgsl and terrain_conform.wgsl.

struct TerrainUpdateParams {
    camLocalRadius : vec4<f32>, // xyz = camera in planet-local space, w = radius
    thresholds : vec4<f32>,     // x = focal, y = splitThreshold(px^2), z = mergeThreshold, w = cullMinDot
    ints : vec4<u32>,           // x = maxDepth, y = parity(0=split,1=merge), z = cullBackface(0/1), w unused
};
@group(0) @binding(1) var<uniform> up : TerrainUpdateParams;

// Projected area (px^2) of a leaf triangle: worldArea * focal^2 / dist^2.
fn terrain_projectedArea(tri : LebTri, radius : f32, camLocal : vec3<f32>, focal : f32) -> f32 {
    let a = tri.a * radius;
    let l = tri.l * radius;
    let r = tri.r * radius;
    let area = 0.5 * length(cross(l - a, r - a));
    let centroid = (a + l + r) * (1.0 / 3.0);
    let d = camLocal - centroid;
    let d2 = dot(d, d);
    if (d2 < 1.0) {
        return 1e30;
    }
    return area * focal * focal / d2;
}

// One leaf vertex is behind the horizon when dot(radialNormal, dirToCamera) is
// below the guard band. `corner` is a unit direction (radial normal) and world pos
// is corner*radius. Mirrors terrain_classify.ts isBackface.
fn terrain_vertexBackface(corner : vec3<f32>, radius : f32, camLocal : vec3<f32>, minDot : f32) -> bool {
    let toCam = camLocal - corner * radius;
    let d = dot(corner, toCam); // |corner| == 1
    if (minDot == 0.0) {
        return d <= 0.0;
    }
    let tl = length(toCam);
    if (tl < 1e-12) {
        return false;
    }
    return d < minDot * tl;
}

// Cull a split candidate only when ALL THREE vertices are behind the horizon, so a
// coarse triangle straddling the horizon can still split (avoids "stuck at min LOD").
fn terrain_triangleBackface(tri : LebTri, radius : f32, camLocal : vec3<f32>, minDot : f32) -> bool {
    return terrain_vertexBackface(tri.a, radius, camLocal, minDot)
        && terrain_vertexBackface(tri.l, radius, camLocal, minDot)
        && terrain_vertexBackface(tri.r, radius, camLocal, minDot);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
    // 2D grid linear index: indirect dispatch caps X at 65535 workgroups (WebGPU
    // limit) and spills the overflow into Y. For 1D dispatches (Y=1) this is gid.x.
    let handle = gid.x + gid.y * nwg.x * 256u;
    let count = terrain_nodeCount();
    if (handle >= count) {
        return;
    }

    let node = terrain_decode(handle);
    let id = node.x;
    let depth = node.y;
    if (depth < TERRAIN_FACE_DEPTH) {
        return; // routing levels are never leaves (defensive guard)
    }

    let radius = up.camLocalRadius.w;
    let camLocal = up.camLocalRadius.xyz;
    let focal = up.thresholds.x;
    let splitT = up.thresholds.y;
    let mergeT = up.thresholds.z;
    let cullMinDot = up.thresholds.w;
    let maxDepth = up.ints.x;
    let parity = up.ints.y;
    let cullBackface = up.ints.z;

    let localDepth = depth - TERRAIN_FACE_DEPTH;
    let face = (id >> localDepth) - 8u;
    let localId = (1u << localDepth) | (id & ((1u << localDepth) - 1u));

    let tri = leb_decode(id, depth);
    let pa = terrain_projectedArea(tri, radius, camLocal, focal);

    if (parity == 0u) {
        // SPLIT: leaf too coarse -> forced-diamond conforming split.
        if (pa > splitT && depth < maxDepth) {
            if (cullBackface == 1u && terrain_triangleBackface(tri, radius, camLocal, cullMinDot)) {
                return;
            }
            terrain_splitConforming(face, localId, localDepth);
        }
    } else {
        // MERGE: conforming diamond collapse. BOTH halves — base (this leaf's
        // parent) and top (the parent's longest-edge neighbor) — must be
        // collapsible (<= 2 leaves) AND want to coarsen (projected area < mergeT),
        // so the whole diamond collapses together and stays watertight. Dupuy's
        // leb_MergeNode gates on BOTH halves; gating on the base alone collapses
        // one side of a diamond and opens a crack (then the next split pass runs
        // its conforming chain on a non-restricted tree and misbehaves).
        if (localDepth >= 1u) {
            let pLocalId = localId >> 1u;
            let pLocalDepth = localDepth - 1u;
            let pdepth = depth - 1u;

            let baseFull = terrain_localToFull(face, pLocalId, pLocalDepth);
            let baseVal = terrain_heapRead(baseFull, pdepth);
            let baseArea = terrain_projectedArea(leb_decode(baseFull, pdepth), radius, camLocal, focal);

            // Diamond top = parent's longest-edge neighbor (cross-face at a seam),
            // so the whole diamond collapses together and seams stay watertight.
            let topNb = terrain_crossEdge(face, pLocalId, pLocalDepth);
            var topVal : u32 = baseVal;
            var topArea : f32 = baseArea;
            if (topNb.valid == 1u) {
                let topFull = terrain_localToFull(topNb.face, topNb.localId, pLocalDepth);
                topVal = terrain_heapRead(topFull, pdepth);
                topArea = terrain_projectedArea(leb_decode(topFull, pdepth), radius, camLocal, focal);
            }

            if (baseVal <= 2u && topVal <= 2u && baseArea < mergeT && topArea < mergeT) {
                terrain_mergeConforming(face, localId, localDepth);
            }
        }
    }
}
