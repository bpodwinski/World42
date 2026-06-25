// OCBT EvaluateLEB pass — df64 / CAMERA-RELATIVE variant (one thread per pool slot).
// The Phase 3 precision path: the f32 unit-dir decode (ocbt_topo_eval_leb) cracks past
// depth ~24 because (a) the ~depth-many normalize steps accumulate f32 error and (b) the
// per-vertex planet-local position (~radius) is f32-quantized (~0.25 m ULP at planet
// scale) so adjacent fine vertices snap together. This pass fixes BOTH:
//   1. Decode the leaf triangle in df64 (vec2<f32> hi/lo, ~48-bit mantissa) so the
//      unit-dir corners stay precise to ~depth 48.
//   2. Emit the corner CAMERA-RELATIVE: relative = dir*radius - camLocal, computed in
//      df64 then narrowed to f32. The subtraction cancels the ~radius magnitude in df64,
//      so the f32 output is small (near the camera) and finely resolved. camLocal is only
//      f32-precise, but that error is a CONSTANT per-frame translation of the whole patch
//      (camLocal is the same for every vertex) — it shifts the patch uniformly (invisible),
//      it does NOT jitter adjacent vertices, so it cannot crack the mesh.
//
// Output layout (18 f32/slot): per corner c in 0..2 -> [relative.xyz, dir.xyz] at
// slot*18 + c*6. relative = camera-relative planet-local position (sim units); dir =
// the f32 unit direction (for the noise height + per-pixel normal). The vertex shader
// does renderPos = mat3(world) * (relative + dir*height) — no big-number multiply, so
// the precision survives to the GPU.
//
// Composed after: engineWgslPreamble + ocbt_u64.wgsl + ocbt_f64.wgsl + common.
// Reuses the metric classify camera UBO (binding 17): camRadius.xyz = camLocal, .w = radius.

struct EvalParams {
    camRadius : vec4<f32>,
    thresh    : vec4<f32>,
    limits    : vec4<f32>
};

// A vec3 in df64: each component carried as (hi, lo).
struct DVec3 { x : vec2<f32>, y : vec2<f32>, z : vec2<f32> };

@group(0) @binding(2)  var<storage, read>       heapID    : array<vec2<u32>>;
@group(0) @binding(17) var<uniform>             ep        : EvalParams;
@group(0) @binding(19) var<storage, read_write> positions : array<f32>;

fn dv_from_f32(x : f32, y : f32, z : f32) -> DVec3 {
    return DVec3(df64_from_f32(x), df64_from_f32(y), df64_from_f32(z));
}
fn dv_add(a : DVec3, b : DVec3) -> DVec3 {
    return DVec3(df64_add(a.x, b.x), df64_add(a.y, b.y), df64_add(a.z, b.z));
}
fn dv_sub(a : DVec3, b : DVec3) -> DVec3 {
    return DVec3(df64_sub(a.x, b.x), df64_sub(a.y, b.y), df64_sub(a.z, b.z));
}
fn dv_scale_f32(a : DVec3, s : f32) -> DVec3 {
    return DVec3(df64_mul_f32(a.x, s), df64_mul_f32(a.y, s), df64_mul_f32(a.z, s));
}
fn dv_scale(a : DVec3, s : vec2<f32>) -> DVec3 {
    return DVec3(df64_mul(a.x, s), df64_mul(a.y, s), df64_mul(a.z, s));
}
// 1/sqrt(x*x+y*y+z*z) in df64, applied to normalize.
fn dv_normalize(a : DVec3) -> DVec3 {
    let len2 = df64_add(df64_add(df64_mul(a.x, a.x), df64_mul(a.y, a.y)), df64_mul(a.z, a.z));
    let inv = df64_invsqrt(len2);
    return dv_scale(a, inv);
}

// Consistently-wound octahedron face corners (apex, left, right) as df64 — mirror of
// GPU_FACE_CORNERS / ocbt_face_corners. Returns three DVec3 via out params.
fn dv_face_corners(face : u32, a : ptr<function, DVec3>, l : ptr<function, DVec3>, r : ptr<function, DVec3>) {
    switch (face) {
        case 0u: { *a = dv_from_f32(0.0, 1.0, 0.0); *l = dv_from_f32(0.0, 0.0, 1.0); *r = dv_from_f32(1.0, 0.0, 0.0); }
        case 1u: { *a = dv_from_f32(0.0, 1.0, 0.0); *l = dv_from_f32(-1.0, 0.0, 0.0); *r = dv_from_f32(0.0, 0.0, 1.0); }
        case 2u: { *a = dv_from_f32(0.0, 1.0, 0.0); *l = dv_from_f32(0.0, 0.0, -1.0); *r = dv_from_f32(-1.0, 0.0, 0.0); }
        case 3u: { *a = dv_from_f32(0.0, 1.0, 0.0); *l = dv_from_f32(1.0, 0.0, 0.0); *r = dv_from_f32(0.0, 0.0, -1.0); }
        case 4u: { *a = dv_from_f32(0.0, -1.0, 0.0); *l = dv_from_f32(1.0, 0.0, 0.0); *r = dv_from_f32(0.0, 0.0, 1.0); }
        case 5u: { *a = dv_from_f32(0.0, -1.0, 0.0); *l = dv_from_f32(0.0, 0.0, 1.0); *r = dv_from_f32(-1.0, 0.0, 0.0); }
        case 6u: { *a = dv_from_f32(0.0, -1.0, 0.0); *l = dv_from_f32(-1.0, 0.0, 0.0); *r = dv_from_f32(0.0, 0.0, -1.0); }
        default: { *a = dv_from_f32(0.0, -1.0, 0.0); *l = dv_from_f32(0.0, 0.0, -1.0); *r = dv_from_f32(1.0, 0.0, 0.0); }
    }
}

fn narrow(a : DVec3) -> vec3<f32> {
    return vec3<f32>(df64_to_f32(a.x), df64_to_f32(a.y), df64_to_f32(a.z));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let id = linear_id(gid, nwg.x);
    if (id >= OCBT_CAPACITY) { return; }

    let heap = heapID[id];
    if (heap_is_zero(heap)) { return; }

    let depth = u64_depth(heap);
    let steps = depth - 3u;
    let face = u64_shr(heap, steps).x - 8u;

    var fa : DVec3; var fl : DVec3; var fr : DVec3;
    dv_face_corners(face, &fa, &fl, &fr);
    // Reference convention seed: v0=right, v1=apex, v2=left. PLANAR barycentric decode:
    // the split-edge midpoint is 0.5*(v0+v2) with NO per-step normalize (closed-form
    // matrix), so each corner stays an exact df64 linear combo of the face seeds and the
    // ~depth chained normalizes that cracked the slerp path near level 24 are gone.
    var v0 = fr;
    var v1 = fa;
    var v2 = fl;
    for (var s : u32 = 0u; s < steps; s = s + 1u) {
        let bit = u64_bit(heap, steps - 1u - s);
        let m = dv_scale_f32(dv_add(v0, v2), 0.5);
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
    // Project the three corners to the unit sphere ONCE (the single projection).
    v0 = dv_normalize(v0);
    v1 = dv_normalize(v1);
    v2 = dv_normalize(v2);

    let radius = ep.camRadius.w;
    let camX = df64_from_f32(ep.camRadius.x);
    let camY = df64_from_f32(ep.camRadius.y);
    let camZ = df64_from_f32(ep.camRadius.z);
    let cam = DVec3(camX, camY, camZ);

    // Unit surface directions (f32) first — needed for both the noise height and the render.
    let d0 = narrow(v0);
    let d1 = narrow(v1);
    let d2 = narrow(v2);

    // Terrain-aware decode: displace each corner radially by the SAME fbm height the render
    // bakes (cbtFbmHeight + CBT_* constants + cbtPerm are composed in by the kernel). So the
    // positions buffer holds the real terrain surface, making screenPx / frustum / horizon
    // terrain-aware. The big radius cancellation is done in df64; the small height add is f32
    // (post-narrow), exactly as the render vertex shader did it.
    // relative_c = dir_c * (radius + height(dir_c)) - camLocal. The height now includes the
    // continued-detail octaves, faded by the per-corner camera distance (length of the
    // smooth-sphere camera-relative base, in sim units = km). Same distance the render's
    // fragment normal uses (vRel) so geometry and shading stay consistent, and per-vertex so
    // a shared corner gets one fade => watertight.
    let base0 = narrow(dv_sub(dv_scale_f32(v0, radius), cam));
    let base1 = narrow(dv_sub(dv_scale_f32(v1, radius), cam));
    let base2 = narrow(dv_sub(dv_scale_f32(v2, radius), cam));
    let rel0 = base0 + d0 * cbtFbmHeightAt(d0, length(base0), radius);
    let rel1 = base1 + d1 * cbtFbmHeightAt(d1, length(base1), radius);
    let rel2 = base2 + d2 * cbtFbmHeightAt(d2, length(base2), radius);

    let b = id * 18u;
    positions[b + 0u] = rel0.x; positions[b + 1u] = rel0.y; positions[b + 2u] = rel0.z;
    positions[b + 3u] = d0.x;   positions[b + 4u] = d0.y;   positions[b + 5u] = d0.z;
    positions[b + 6u] = rel1.x; positions[b + 7u] = rel1.y; positions[b + 8u] = rel1.z;
    positions[b + 9u] = d1.x;   positions[b + 10u] = d1.y;  positions[b + 11u] = d1.z;
    positions[b + 12u] = rel2.x; positions[b + 13u] = rel2.y; positions[b + 14u] = rel2.z;
    positions[b + 15u] = d2.x;  positions[b + 16u] = d2.y;  positions[b + 17u] = d2.z;
}
