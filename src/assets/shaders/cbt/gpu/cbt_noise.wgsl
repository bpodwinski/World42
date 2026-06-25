// CBT procedural noise — WGSL port of _cbtNoise.glsl (itself a port of cbt_noise.ts).
// Gustavson 3D simplex with analytic gradient + fbm. The includer must define the
// baked constants and the permutation storage buffer BEFORE this file:
//   const CBT_OCTAVES : i32 = ...;
//   const CBT_BASE_FREQ : f32 = ...;   const CBT_BASE_AMP : f32 = ...;
//   const CBT_LACUNARITY : f32 = ...;  const CBT_PERSISTENCE : f32 = ...;
//   const CBT_GLOBAL_AMP : f32 = ...;
//   var<storage, read> cbtPerm : array<u32>;   // 256 entries, values 0..255
// Callers of the *_at (continued-detail) helpers must ALSO define:
//   const CBT_DETAIL_OCTAVES : i32 = ...;  // extra octaves past CBT_OCTAVES (0 = off)
//   const CBT_DETAIL_RANGE : f32 = ...;    // fade-in distance in wavelengths (~60)

const CBT_MAX_OCTAVES : i32 = 12;
const CBT_MAX_DETAIL : i32 = 12;

fn cbtGrad3(i : i32) -> vec3<f32> {
    switch (i % 12) {
        case 0: { return vec3<f32>(1.0, 1.0, 0.0); }
        case 1: { return vec3<f32>(-1.0, 1.0, 0.0); }
        case 2: { return vec3<f32>(1.0, -1.0, 0.0); }
        case 3: { return vec3<f32>(-1.0, -1.0, 0.0); }
        case 4: { return vec3<f32>(1.0, 0.0, 1.0); }
        case 5: { return vec3<f32>(-1.0, 0.0, 1.0); }
        case 6: { return vec3<f32>(1.0, 0.0, -1.0); }
        case 7: { return vec3<f32>(-1.0, 0.0, -1.0); }
        case 8: { return vec3<f32>(0.0, 1.0, 1.0); }
        case 9: { return vec3<f32>(0.0, -1.0, 1.0); }
        case 10: { return vec3<f32>(0.0, 1.0, -1.0); }
        default: { return vec3<f32>(0.0, -1.0, -1.0); }
    }
}

fn cbtPermAt(i : i32) -> i32 {
    return i32(cbtPerm[u32(i & 255)]);
}

fn cbtCorner(d : vec3<f32>, gi : i32, n : ptr<function, f32>, grad : ptr<function, vec3<f32>>) {
    let t = 0.6 - dot(d, d);
    if (t <= 0.0) {
        return;
    }
    let g = cbtGrad3(gi % 12);
    let gd = dot(g, d);
    let t2 = t * t;
    let t3 = t2 * t;
    let t4 = t2 * t2;
    *n = *n + t4 * gd;
    *grad = *grad + t4 * g - 8.0 * t3 * gd * d;
}

// vec4(value, d/dx, d/dy, d/dz); value ~ [-1, 1].
fn cbtSimplex3_d(p : vec3<f32>) -> vec4<f32> {
    let F3 = 1.0 / 3.0;
    let G3 = 1.0 / 6.0;

    let s = (p.x + p.y + p.z) * F3;
    let ijk = floor(p + vec3<f32>(s));
    let t = (ijk.x + ijk.y + ijk.z) * G3;
    let p0 = p - (ijk - vec3<f32>(t));

    var e1 : vec3<f32>;
    var e2 : vec3<f32>;
    if (p0.x >= p0.y) {
        if (p0.y >= p0.z) { e1 = vec3<f32>(1.0, 0.0, 0.0); e2 = vec3<f32>(1.0, 1.0, 0.0); }
        else if (p0.x >= p0.z) { e1 = vec3<f32>(1.0, 0.0, 0.0); e2 = vec3<f32>(1.0, 0.0, 1.0); }
        else { e1 = vec3<f32>(0.0, 0.0, 1.0); e2 = vec3<f32>(1.0, 0.0, 1.0); }
    } else {
        if (p0.y < p0.z) { e1 = vec3<f32>(0.0, 0.0, 1.0); e2 = vec3<f32>(0.0, 1.0, 1.0); }
        else if (p0.x < p0.z) { e1 = vec3<f32>(0.0, 1.0, 0.0); e2 = vec3<f32>(0.0, 1.0, 1.0); }
        else { e1 = vec3<f32>(0.0, 1.0, 0.0); e2 = vec3<f32>(1.0, 1.0, 0.0); }
    }

    let p1 = p0 - e1 + vec3<f32>(G3);
    let p2 = p0 - e2 + vec3<f32>(2.0 * G3);
    let p3 = p0 - vec3<f32>(1.0) + vec3<f32>(3.0 * G3);

    let ix = i32(ijk.x) & 255;
    let iy = i32(ijk.y) & 255;
    let iz = i32(ijk.z) & 255;
    let e1i = vec3<i32>(i32(e1.x), i32(e1.y), i32(e1.z));
    let e2i = vec3<i32>(i32(e2.x), i32(e2.y), i32(e2.z));

    var n : f32 = 0.0;
    var grad : vec3<f32> = vec3<f32>(0.0);

    let gi0 = cbtPermAt(ix +          cbtPermAt(iy +          cbtPermAt(iz)));
    let gi1 = cbtPermAt(ix + e1i.x +  cbtPermAt(iy + e1i.y +  cbtPermAt(iz + e1i.z)));
    let gi2 = cbtPermAt(ix + e2i.x +  cbtPermAt(iy + e2i.y +  cbtPermAt(iz + e2i.z)));
    let gi3 = cbtPermAt(ix + 1 +      cbtPermAt(iy + 1 +      cbtPermAt(iz + 1)));

    cbtCorner(p0, gi0, &n, &grad);
    cbtCorner(p1, gi1, &n, &grad);
    cbtCorner(p2, gi2, &n, &grad);
    cbtCorner(p3, gi3, &n, &grad);

    return vec4<f32>(32.0 * n, 32.0 * grad);
}

// fbm with analytic gradient. Returns vec4(height, dHeight/dp.xyz).
fn cbtFbm_d(p : vec3<f32>) -> vec4<f32> {
    var sum : f32 = 0.0;
    var maxPossible : f32 = 0.0;
    var grad : vec3<f32> = vec3<f32>(0.0);
    var freq : f32 = CBT_BASE_FREQ;
    var amp : f32 = CBT_BASE_AMP;

    for (var i : i32 = 0; i < CBT_MAX_OCTAVES; i = i + 1) {
        if (i >= CBT_OCTAVES) {
            break;
        }
        let sd = cbtSimplex3_d(p * freq);
        sum = sum + sd.x * amp;
        grad = grad + sd.yzw * (amp * freq);
        maxPossible = maxPossible + amp;
        freq = freq * CBT_LACUNARITY;
        amp = amp * CBT_PERSISTENCE;
    }

    if (maxPossible <= 1e-12) {
        return vec4<f32>(0.0);
    }
    let inv = CBT_GLOBAL_AMP / maxPossible;
    return vec4<f32>(sum * inv, grad * inv);
}

fn cbtFbmHeight(dir : vec3<f32>) -> f32 {
    return cbtFbm_d(dir).x;
}

// Continued-detail fbm with per-octave camera-distance fade. Returns vec4(height, dHeight/dp).
// The macro band (i < CBT_OCTAVES) is identical to cbtFbm_d and normalized by the MACRO
// maxPossible ONLY, so it never shifts when detail fades — the CPU collision / other LOD
// backends keep matching the macro surface. CBT_DETAIL_OCTAVES extra octaves CONTINUE the
// cascade (freq *= lacunarity, amp *= persistence) and ADD on top, each faded in by camera
// distance: a feature of wavelength wl(km) = radiusKm / freq is only sampled once the camera
// is within ~CBT_DETAIL_RANGE wavelengths (closer => triangles small enough to carry it, no
// aliasing) and fully on within half that. `camDistKm` is per-VERTEX (length of the camera-
// relative position) so a shared vertex gets one fade => watertight, no cracks. At f32 the
// detail stays precise to ~20-30 m wavelength (dir*freq keeps enough mantissa); below that a
// df64 local-frame decode would be needed (deliberately out of scope here).
fn cbtFbm_d_at(p : vec3<f32>, camDistKm : f32, radiusKm : f32) -> vec4<f32> {
    var sum : f32 = 0.0;
    var maxMacro : f32 = 0.0;
    var grad : vec3<f32> = vec3<f32>(0.0);
    var freq : f32 = CBT_BASE_FREQ;
    var amp : f32 = CBT_BASE_AMP;

    for (var i : i32 = 0; i < CBT_MAX_OCTAVES; i = i + 1) {
        if (i >= CBT_OCTAVES) { break; }
        let sd = cbtSimplex3_d(p * freq);
        sum = sum + sd.x * amp;
        grad = grad + sd.yzw * (amp * freq);
        maxMacro = maxMacro + amp;
        freq = freq * CBT_LACUNARITY;
        amp = amp * CBT_PERSISTENCE;
    }

    if (maxMacro <= 1e-12) {
        return vec4<f32>(0.0);
    }

    for (var j : i32 = 0; j < CBT_MAX_DETAIL; j = j + 1) {
        if (j >= CBT_DETAIL_OCTAVES) { break; }
        let wlKm = radiusKm / freq;
        let onKm = CBT_DETAIL_RANGE * wlKm;
        let fade = 1.0 - smoothstep(onKm, onKm * 2.0, camDistKm);
        if (fade > 0.0) {
            let sd = cbtSimplex3_d(p * freq);
            sum = sum + sd.x * (amp * fade);
            grad = grad + sd.yzw * (amp * freq * fade);
        }
        freq = freq * CBT_LACUNARITY;
        amp = amp * CBT_PERSISTENCE;
    }

    let inv = CBT_GLOBAL_AMP / maxMacro;
    return vec4<f32>(sum * inv, grad * inv);
}

fn cbtFbmHeightAt(dir : vec3<f32>, camDistKm : f32, radiusKm : f32) -> f32 {
    return cbtFbm_d_at(dir, camDistKm, radiusKm).x;
}

fn cbtSphereTangents(nrm : vec3<f32>, tang : ptr<function, vec3<f32>>, bitan : ptr<function, vec3<f32>>) {
    var a : vec3<f32>;
    if (abs(nrm.y) > 0.9) { a = vec3<f32>(1.0, 0.0, 0.0); } else { a = vec3<f32>(0.0, 1.0, 0.0); }
    *tang = normalize(cross(nrm, a));
    *bitan = cross(nrm, *tang);
}

fn cbtNoiseNormal(dir : vec3<f32>, radius : f32) -> vec3<f32> {
    let nrm = normalize(dir);
    var tang : vec3<f32>;
    var bitan : vec3<f32>;
    cbtSphereTangents(nrm, &tang, &bitan);

    let grad = cbtFbm_d(nrm).yzw;
    let dhdt = dot(grad, tang);
    let dhdb = dot(grad, bitan);

    let sc = 1.0 / radius;
    let pn = nrm - dhdt * sc * tang - dhdb * sc * bitan;
    return normalize(pn);
}

// Per-pixel normal that INCLUDES the faded detail octaves, so shading matches the
// continued-detail geometry from cbtFbm_d_at. camDistKm must be the same distance the
// height decode used for this surface point (length of the camera-relative position).
fn cbtNoiseNormalAt(dir : vec3<f32>, radius : f32, camDistKm : f32) -> vec3<f32> {
    let nrm = normalize(dir);
    var tang : vec3<f32>;
    var bitan : vec3<f32>;
    cbtSphereTangents(nrm, &tang, &bitan);

    let grad = cbtFbm_d_at(nrm, camDistKm, radius).yzw;
    let dhdt = dot(grad, tang);
    let dhdb = dot(grad, bitan);

    let sc = 1.0 / radius;
    let pn = nrm - dhdt * sc * tang - dhdb * sc * bitan;
    return normalize(pn);
}
