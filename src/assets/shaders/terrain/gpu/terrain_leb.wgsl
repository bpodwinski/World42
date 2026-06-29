// Longest-edge-bisection decode for the octahedron quad-sphere, WGSL. Mirrors the
// CPU TerrainState.subdivide exactly: a triangle (A=apex, L=left, R=right) bisects its
// base edge (L,R) at VC = normalize(L+R); child0 = (VC, A, L), child1 = (VC, R, A).
// The 8 octahedron faces are the depth-3 nodes (ids 8..15). A heap node (id, depth)
// (depth >= 3) decodes to its leaf triangle by selecting the face from the high
// bits, then applying (depth-3) bisections from the remaining bits, MSB first.
//
// Corners are returned as unit directions on the sphere; the caller scales by the
// radius and adds the radial noise displacement.

struct LebTri {
    a : vec3<f32>,
    l : vec3<f32>,
    r : vec3<f32>,
};

// Octahedron faces, mirror of ROOT_ALR + VX in terrain_state.ts (apex, left, right).
fn leb_faceCorners(face : u32) -> LebTri {
    switch (face) {
        case 0u: { return LebTri(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0)); }
        case 1u: { return LebTri(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(-1.0, 0.0, 0.0)); }
        case 2u: { return LebTri(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, -1.0)); }
        case 3u: { return LebTri(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, -1.0), vec3<f32>(1.0, 0.0, 0.0)); }
        case 4u: { return LebTri(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0)); }
        case 5u: { return LebTri(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(-1.0, 0.0, 0.0)); }
        case 6u: { return LebTri(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, -1.0)); }
        default: { return LebTri(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 0.0, -1.0), vec3<f32>(1.0, 0.0, 0.0)); }
    }
}

fn leb_decode(id : u32, depth : u32) -> LebTri {
    let face = (id >> (depth - 3u)) - 8u;
    let fc = leb_faceCorners(face);
    // Dupuy longest-edge-bisection convention (leb__SplittingMatrix): the split
    // edge is (v0, v2) and the apex is the MIDDLE vertex v1; child0 = (v0, M, v1),
    // child1 = (v1, M, v2), M = mid(v0, v2). This is the convention the same-depth
    // neighbor decode (terrain_conform.wgsl) is built for, so decode + neighbor agree
    // and the mesh is watertight within a face. Feed the face as (v0=L, v1=apex,
    // v2=R) so the first bisection splits the equatorial hypotenuse (L,R).
    var v0 = fc.l;
    var v1 = fc.a;
    var v2 = fc.r;
    let steps = depth - 3u;
    for (var s : u32 = 0u; s < steps; s = s + 1u) {
        let bitpos = steps - 1u - s;
        let bit = (id >> bitpos) & 1u;
        let m = normalize(v0 + v2);
        let ov1 = v1;
        if (bit == 0u) {
            v1 = m;
            v2 = ov1;
        } else {
            v0 = ov1;
            v1 = m;
        }
    }
    return LebTri(v0, v1, v2);
}
