// OCBT vertex decode (WGSL) — REFERENCE leb convention over the consistently-wound
// octahedron. Bit-for-bit twin of src/systems/lod/cbt/ocbt/ocbt_eval_leb.ts (itself
// the proven Phase 1c cross-check decoder). Given a u64 heap id, returns the leaf
// triangle's three corners as unit directions on the sphere; the caller scales by
// radius and adds the radial noise displacement.
//
// This is NOT the legacy cbt_leb.wgsl convention — the OCBT engine stores heap ids in
// the reference convention over GPU_FACE_CORNERS (seed reoriented for a consistently
// oriented octahedron), so the render path MUST decode with this file.
//
// Requires ocbt_u64.wgsl (u64_depth / u64_shr / u64_bit) composed BEFORE it.

struct OcbtTri {
    c0 : vec3<f32>,
    c1 : vec3<f32>,
    c2 : vec3<f32>,
};

// Consistently-wound octahedron face corners (apex, left, right). Mirror of
// GPU_FACE_CORNERS in ocbt_eval_leb.ts. Returns OcbtTri(a, l, r).
fn ocbt_face_corners(face : u32) -> OcbtTri {
    switch (face) {
        case 0u: { return OcbtTri(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0)); }
        case 1u: { return OcbtTri(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0)); }
        case 2u: { return OcbtTri(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, -1.0), vec3<f32>(-1.0, 0.0, 0.0)); }
        case 3u: { return OcbtTri(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, -1.0)); }
        case 4u: { return OcbtTri(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0)); }
        case 5u: { return OcbtTri(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(-1.0, 0.0, 0.0)); }
        case 6u: { return OcbtTri(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, -1.0)); }
        default: { return OcbtTri(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 0.0, -1.0), vec3<f32>(1.0, 0.0, 0.0)); }
    }
}

// Decode (heap : u64) -> leaf triangle (v0, v1, v2) as unit directions. Seed
// v0=right, v1=apex, v2=left; bit0: v0'=v2, v1'=mid(v0,v2), v2'=v1; bit1: v0'=v1,
// v1'=mid, v2'=v0. The split-edge midpoint is PLANAR (0.5*(v0+v2), NO per-step
// normalize), so each corner stays an exact linear combo of the face seeds (= the
// closed-form barycentric matrix W applied to the seed); the 3 corners are projected
// to the sphere ONCE at return. Bit-identical to the old slerp through depth 4,
// micro-divergent beyond. MSB-first path bits.
fn ocbt_leb_decode(heap : vec2<u32>) -> OcbtTri {
    let depth = u64_depth(heap);
    let steps = depth - 3u;
    let face = u64_shr(heap, steps).x - 8u;
    let fc = ocbt_face_corners(face);
    var v0 = fc.c2; // right
    var v1 = fc.c0; // apex
    var v2 = fc.c1; // left
    for (var s : u32 = 0u; s < steps; s = s + 1u) {
        let bit = u64_bit(heap, steps - 1u - s);
        let m = (v0 + v2) * 0.5;
        if (bit == 0u) {
            let nv0 = v2; // v0'=v2
            v2 = v1;      // v2'=v1
            v0 = nv0;
            v1 = m;
        } else {
            let nv0 = v1; // v0'=v1
            let nv2 = v0; // v2'=v0
            v0 = nv0;
            v1 = m;
            v2 = nv2;
        }
    }
    return OcbtTri(normalize(v0), normalize(v1), normalize(v2));
}
