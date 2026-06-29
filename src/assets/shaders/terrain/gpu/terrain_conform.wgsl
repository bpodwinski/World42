// Forced-diamond conforming split/merge for the TERRAIN (Dupuy 2021, longest-edge
// bisection), extended across the 8-face octahedron so the mesh is watertight
// EVERYWHERE (intra-face AND across the 12 seams). Validated in CPU isolation
// (cross_face_check.test.ts): zero T-junctions, batch mode (= the GPU pass).
//
//   - terrain_edgeNeighborLocal: Dupuy leb__SplitNodeIDs (.edge) same-depth neighbor,
//     0 when the split edge is on a face boundary (a seam).
//   - terrain_crossEdge: split-edge neighbor as (face, localId), crossing the seam
//     geometrically (decode the split edge -> adjacent face -> encode the matching
//     node). Pure id + geometry math, NO heap reads, so a batch of conforming
//     splits applied to a stale snapshot then reduced once stays watertight.
//   - terrain_splitConforming: bisect node, then walk the longest-edge compatibility
//     chain (cross-face) bisecting node + parent at each step, up to the equatorial
//     base diamond.
//   - terrain_mergeConforming: clear the right-sibling bit (terrain_MergeNode).
//
// World42 specifics: the 8 octahedron faces are the depth-3 heap nodes (ids 8..15).
// Within a face the local LEB tree adds (depth-3) bits below the 3 face bits.
//
// Composed AFTER `const TERRAIN_MAX_DEPTH`, terrain_heap_rw.wgsl (binding 0) and
// terrain_leb.wgsl (leb_decode / leb_faceCorners / LebTri). Uses terrain_setBit /
// terrain_bfIndex from terrain_heap_rw.wgsl.

const TERRAIN_FACE_DEPTH : u32 = 3u;

// Full heap id of a within-face node (local id = leading 1 + localDepth path bits).
fn terrain_localToFull(face : u32, localId : u32, localDepth : u32) -> u32 {
    let path = localId & ((1u << localDepth) - 1u);
    return ((8u + face) << localDepth) | path;
}

// Longest-edge same-depth neighbor id within one face (0 == on the face boundary).
fn terrain_edgeNeighborLocal(localId : u32, localDepth : u32) -> u32 {
    var nLeft : u32 = 0u;
    var nRight : u32 = 0u;
    var nEdge : u32 = 0u;
    var nNode : u32 = 1u;
    var bit : i32 = i32(localDepth) - 1;
    loop {
        if (bit < 0) { break; }
        let splitBit = (localId >> u32(bit)) & 1u;
        let n1 = nLeft;
        let n2 = nRight;
        let n3 = nEdge;
        let n4 = nNode;
        let b2 = select(0u, 1u, n2 != 0u);
        let b3 = select(0u, 1u, n3 != 0u);
        if (splitBit == 0u) {
            nLeft  = (n4 << 1u) | 1u;
            nRight = (n3 << 1u) | b3;
            nEdge  = (n2 << 1u) | b2;
            nNode  = (n4 << 1u);
        } else {
            nLeft  = (n3 << 1u);
            nRight = (n4 << 1u);
            nEdge  = (n1 << 1u);
            nNode  = (n4 << 1u) | 1u;
        }
        bit = bit - 1;
    }
    return nEdge;
}

// terrain_SplitNode: set the right child's leaf bit of a within-face node.
fn terrain_rawSplitFace(face : u32, localId : u32, localDepth : u32) {
    let fullId = terrain_localToFull(face, localId, localDepth);
    let depth = localDepth + TERRAIN_FACE_DEPTH;
    let rc = (fullId << 1u) | 1u;
    terrain_setBit(terrain_bfIndex(rc, depth + 1u), 1u);
}

// --- cross-face (octahedron seam) split-edge neighbor -------------------------

// Per-face axis-vertex indices (AXIS order: +x0 -x1 +y2 -y3 +z4 -z5), mirror of
// FACE_ALR (apex, L, R) in terrain_state.ts.
fn terrain_faceAxes(face : u32) -> vec3<u32> {
    switch (face) {
        case 0u: { return vec3<u32>(2u, 0u, 4u); }
        case 1u: { return vec3<u32>(2u, 4u, 1u); }
        case 2u: { return vec3<u32>(2u, 1u, 5u); }
        case 3u: { return vec3<u32>(2u, 5u, 0u); }
        case 4u: { return vec3<u32>(3u, 0u, 4u); }
        case 5u: { return vec3<u32>(3u, 4u, 1u); }
        case 6u: { return vec3<u32>(3u, 1u, 5u); }
        default: { return vec3<u32>(3u, 5u, 0u); }
    }
}
fn terrain_faceHasAxis(face : u32, ax : u32) -> bool {
    let a = terrain_faceAxes(face);
    return a.x == ax || a.y == ax || a.z == ax;
}

// The face != `face` that shares the seam edge containing segment (P,Q). The seam
// lies in a coordinate plane (one coord ~ 0); the midpoint's other two coord signs
// pick the two axis vertices it connects.
fn terrain_adjacentFace(face : u32, P : vec3<f32>, Q : vec3<f32>) -> u32 {
    let m = normalize(P + Q);
    let am = abs(m);
    var zc : u32 = 0u;
    var mn : f32 = am.x;
    if (am.y < mn) { zc = 1u; mn = am.y; }
    if (am.z < mn) { zc = 2u; mn = am.z; }
    var a : u32 = 99u;
    var b : u32 = 99u;
    var got : u32 = 0u;
    if (zc != 0u) {
        let ax = select(1u, 0u, m.x > 0.0);
        if (got == 0u) { a = ax; got = 1u; } else { b = ax; }
    }
    if (zc != 1u) {
        let ay = select(3u, 2u, m.y > 0.0);
        if (got == 0u) { a = ay; got = 1u; } else { b = ay; }
    }
    if (zc != 2u) {
        let az = select(5u, 4u, m.z > 0.0);
        if (got == 0u) { a = az; got = 1u; } else { b = az; }
    }
    for (var f : u32 = 0u; f < 8u; f = f + 1u) {
        if (f != face && terrain_faceHasAxis(f, a) && terrain_faceHasAxis(f, b)) {
            return f;
        }
    }
    return face;
}

// Outside-penalty of point x vs spherical triangle (a,b,c): 0 inside (closed),
// positive outside. Robustly picks the child that contains the seam sub-edge.
fn terrain_penEdge(x : vec3<f32>, e1 : vec3<f32>, e2 : vec3<f32>, opp : vec3<f32>) -> f32 {
    let n = cross(e1, e2);
    var s = dot(x, n);
    let r = dot(opp, n);
    if (r < 0.0) { s = -s; }
    if (s < -1e-7) { return -s; }
    return 0.0;
}
fn terrain_outPenalty(x : vec3<f32>, a : vec3<f32>, b : vec3<f32>, c : vec3<f32>) -> f32 {
    return terrain_penEdge(x, a, b, c) + terrain_penEdge(x, b, c, a) + terrain_penEdge(x, c, a, b);
}

// Local id (at depth `d`) of the node in faceB whose split edge == {P,Q}.
fn terrain_encodeByEdge(faceB : u32, P : vec3<f32>, Q : vec3<f32>, d : u32) -> u32 {
    let fc = leb_faceCorners(faceB);
    var v0 = fc.l;
    var v1 = fc.a;
    var v2 = fc.r;
    var lid : u32 = 1u;
    for (var k : u32 = 0u; k < d; k = k + 1u) {
        let m = normalize(v0 + v2);
        let ov1 = v1;
        let p0 = terrain_outPenalty(P, v0, m, ov1) + terrain_outPenalty(Q, v0, m, ov1);
        let p1 = terrain_outPenalty(P, ov1, m, v2) + terrain_outPenalty(Q, ov1, m, v2);
        if (p0 <= p1) {
            v1 = m;
            v2 = ov1;
            lid = lid << 1u;
        } else {
            v0 = ov1;
            v1 = m;
            lid = (lid << 1u) | 1u;
        }
    }
    return lid;
}

struct TerrainCrossNb {
    face : u32,
    localId : u32,
    valid : u32,
};

// Split-edge neighbor as (face, localId) at the same localDepth, crossing the
// octahedron seam when the split edge is on a face boundary.
fn terrain_crossEdge(face : u32, localId : u32, localDepth : u32) -> TerrainCrossNb {
    let e = terrain_edgeNeighborLocal(localId, localDepth);
    if (e != 0u) {
        return TerrainCrossNb(face, e, 1u);
    }
    let tri = leb_decode(terrain_localToFull(face, localId, localDepth), localDepth + TERRAIN_FACE_DEPTH);
    let P = tri.a; // split edge = (v0, v2) = (tri.a, tri.r)
    let Q = tri.r;
    let fB = terrain_adjacentFace(face, P, Q);
    let nLid = terrain_encodeByEdge(fB, P, Q, localDepth);
    return TerrainCrossNb(fB, nLid, 1u);
}

// Conforming split: bisect the node, then walk the longest-edge compatibility
// chain (cross-face) bisecting node + parent at each step, up to the equatorial
// base diamond. Idempotent bit-sets, no heap reads -> race-free + batch-safe.
fn terrain_splitConforming(face0 : u32, lid0 : u32, ld0 : u32) {
    terrain_rawSplitFace(face0, lid0, ld0);
    var nb = terrain_crossEdge(face0, lid0, ld0);
    if (nb.valid == 0u) { return; }
    var cf = nb.face;
    var clid = nb.localId;
    var cld = ld0;
    for (var i : u32 = 0u; i < 6u * TERRAIN_MAX_DEPTH; i = i + 1u) {
        terrain_rawSplitFace(cf, clid, cld);
        if (cld == 0u) {
            // base level: couple the equatorial diamond (split the paired root).
            let pr = terrain_crossEdge(cf, clid, cld);
            if (pr.valid == 1u) { terrain_rawSplitFace(pr.face, pr.localId, 0u); }
            return;
        }
        clid = clid >> 1u;     // parent (same face)
        cld = cld - 1u;
        terrain_rawSplitFace(cf, clid, cld);
        if (cld == 0u) {
            let pr = terrain_crossEdge(cf, clid, cld);
            if (pr.valid == 1u) { terrain_rawSplitFace(pr.face, pr.localId, 0u); }
            return;
        }
        nb = terrain_crossEdge(cf, clid, cld); // parent's edge neighbor (same depth)
        if (nb.valid == 0u) { return; }
        cf = nb.face;
        clid = nb.localId;
    }
}

// terrain_MergeNode: clear the right-sibling bit (id | 1) of a within-face leaf, which
// reverts its parent to a single (left) leaf. Both children of a diamond half
// compute the same target bit, so it is idempotent and race-free.
fn terrain_mergeConforming(face : u32, localId : u32, localDepth : u32) {
    let fullId = terrain_localToFull(face, localId, localDepth);
    let depth = localDepth + TERRAIN_FACE_DEPTH;
    terrain_setBit(terrain_bfIndex(fullId | 1u, depth), 0u);
}
