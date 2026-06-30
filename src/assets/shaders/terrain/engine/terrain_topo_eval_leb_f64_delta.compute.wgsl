// TERRAIN EvaluateLEB — delta df64 variant (one thread per newly-allocated slot).
// Covers slots created by the Allocate pass in the CURRENT frame that are absent from
// the previous compact's bisectorIndices list. Dispatched O(new_slots) over the
// allocate[] buffer via the existing ARG.ALLOCATE indirect record.
//
// Composed after: engineWgslPreamble + noiseHeader + terrain_noise.wgsl +
//   terrain_u64.wgsl + terrain_f64.wgsl + terrain_noise_df64.wgsl + terrain_topo_common.wgsl.

struct EvalParams {
    camRadius   : vec4<f32>,
    thresh      : vec4<f32>,
    limits      : vec4<f32>,
    camRadiusLo : vec4<f32>
};

struct DVec3 { x : vec2<f32>, y : vec2<f32>, z : vec2<f32> };

@group(0) @binding(2)  var<storage, read>       heapID    : array<vec2<u32>>;
@group(0) @binding(8)  var<storage, read>        allocate  : array<u32>;
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
fn dv_normalize(a : DVec3) -> DVec3 {
    let len2 = df64_add(df64_add(df64_mul(a.x, a.x), df64_mul(a.y, a.y)), df64_mul(a.z, a.z));
    let inv = df64_invsqrt(len2);
    return dv_scale(a, inv);
}

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

fn cornerHeight(v : DVec3, d : vec3<f32>, distKm : f32, radius : f32) -> f32 {
    if (distKm < ep.limits.z) {
        return terrainFbmHeightAt_df64(v.x, v.y, v.z, distKm, radius);
    }
    return terrainFbmHeightAt(d, distKm, radius);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let i = linear_id(gid, nwg.x);
    if (i >= allocate[0]) { return; } // allocate[0] = count of new slots this frame
    let id = allocate[i + 1u];        // allocate[1..count] = newly-allocated slot IDs

    let heap = heapID[id];
    // No heap_is_zero guard: every allocate[] entry is a freshly-created live slot.

    let depth = u64_depth(heap);
    let steps = depth - 3u;
    let face = u64_shr(heap, steps).x - 8u;

    var fa : DVec3; var fl : DVec3; var fr : DVec3;
    dv_face_corners(face, &fa, &fl, &fr);
    var v0 = fr;
    var v1 = fa;
    var v2 = fl;
    for (var s : u32 = 0u; s < steps; s = s + 1u) {
        let bit = u64_bit(heap, steps - 1u - s);
        let m = dv_scale_f32(dv_add(v0, v2), 0.5);
        if (bit == 0u) {
            let nv0 = v2;
            v2 = v1;
            v0 = nv0;
            v1 = m;
        } else {
            let nv0 = v1;
            let nv2 = v0;
            v0 = nv0;
            v1 = m;
            v2 = nv2;
        }
    }
    v0 = dv_normalize(v0);
    v1 = dv_normalize(v1);
    v2 = dv_normalize(v2);

    let radius = ep.camRadius.w;
    let cam = DVec3(
        vec2<f32>(ep.camRadius.x, ep.camRadiusLo.x),
        vec2<f32>(ep.camRadius.y, ep.camRadiusLo.y),
        vec2<f32>(ep.camRadius.z, ep.camRadiusLo.z)
    );

    let d0 = narrow(v0);
    let d1 = narrow(v1);
    let d2 = narrow(v2);

    let base0 = narrow(dv_sub(dv_scale_f32(v0, radius), cam));
    let base1 = narrow(dv_sub(dv_scale_f32(v1, radius), cam));
    let base2 = narrow(dv_sub(dv_scale_f32(v2, radius), cam));
    let dist0 = length(base0);
    let dist1 = length(base1);
    let dist2 = length(base2);
    let rel0 = base0 + d0 * cornerHeight(v0, d0, dist0, radius);
    let rel1 = base1 + d1 * cornerHeight(v1, d1, dist1, radius);
    let rel2 = base2 + d2 * cornerHeight(v2, d2, dist2, radius);

    let b = id * 18u;
    positions[b + 0u] = rel0.x; positions[b + 1u] = rel0.y; positions[b + 2u] = rel0.z;
    positions[b + 3u] = d0.x;   positions[b + 4u] = d0.y;   positions[b + 5u] = d0.z;
    positions[b + 6u] = rel1.x; positions[b + 7u] = rel1.y; positions[b + 8u] = rel1.z;
    positions[b + 9u] = d1.x;   positions[b + 10u] = d1.y;  positions[b + 11u] = d1.z;
    positions[b + 12u] = rel2.x; positions[b + 13u] = rel2.y; positions[b + 14u] = rel2.z;
    positions[b + 15u] = d2.x;  positions[b + 16u] = d2.y;  positions[b + 17u] = d2.z;
}
