// Longest-edge-bisection decode for the octahedron quad-sphere, WGSL. Mirrors the
// CPU CbtState.subdivide exactly: a triangle (A=apex, L=left, R=right) bisects its
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

// Octahedron faces, mirror of ROOT_ALR + VX in cbt_state.ts (apex, left, right).
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
    var tri = leb_faceCorners(face);
    let steps = depth - 3u;
    for (var s : u32 = 0u; s < steps; s = s + 1u) {
        let bitpos = steps - 1u - s;
        let bit = (id >> bitpos) & 1u;
        let vc = normalize(tri.l + tri.r);
        if (bit == 0u) {
            // child0 = (VC, A, L)
            tri = LebTri(vc, tri.a, tri.l);
        } else {
            // child1 = (VC, R, A)
            tri = LebTri(vc, tri.r, tri.a);
        }
    }
    return tri;
}
