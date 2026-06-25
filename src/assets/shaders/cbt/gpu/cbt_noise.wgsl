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

// --- CRATER FIELD (Worley cellular + radial profile, analytic gradient) -------------------
// Real geometric craters: the DOMINANT relief of an airless body. Added to the fbm height AND
// gradient so crater walls displace the geometry AND shade correctly (the gradient flows through
// cbtNoiseNormalAt's tangent projection). Crater frequencies are low (cell >= ~20 km) so the cell
// coords are EXACT in f32 — the df64 path reuses this verbatim on the narrowed dir. Same math is
// mirrored in cbt_noise.ts (CPU, collision). Hash uses cbtPermAt ONLY (bit-identical f64/f32).
const CBT_CRATER_CLASSES : i32 = 6;
const CBT_CRATER_SCALE : f32 = 1.0; // global crater depth multiplier (per-planet tuning hook)
const CBT_CRATER_RANGE : f32 = 60.0; // class fades only when far enough to be sub-pixel (onKm =
                                     // RANGE*cell, fade onKm..2*onKm). ~detailRange so big craters
                                     // stay visible from orbit; only truly tiny ones drop (AA).
const CBT_CRATER_NEAR : f32 = 0.10; // NORMAL-only: skip classes much BIGGER than camDist (locally flat
                                    // wall -> negligible per-pixel shading). HEIGHT keeps all classes.

// Per size-class params: x = cell size (km, -> freq = radiusKm/cell), y = crater radius (frac of
// cell), z = depth (km), w = density (fraction of cells that spawn a crater). Big rare -> small
// frequent. Classes 4-5 are SMALL (~2.4 km / ~0.8 km craters) for ground-scale detail; cells stay
// >= 2 km so f32 cell coords remain exact (no df64 needed).
fn craterParams(k : i32) -> vec4<f32> {
    switch (k) {
        case 0: { return vec4<f32>(750.0, 0.20, 18.0, 0.5); }
        case 1: { return vec4<f32>(220.0, 0.20, 7.0, 0.6); }
        case 2: { return vec4<f32>(70.0, 0.20, 2.5, 0.7); }
        case 3: { return vec4<f32>(20.0, 0.20, 0.9, 0.8); }
        case 4: { return vec4<f32>(6.0, 0.20, 0.32, 0.82); }
        default: { return vec4<f32>(2.0, 0.20, 0.12, 0.85); }
    }
}

// Radial crater profile h(rn) (rn = dist/radius) + derivative h'(rn). C1, compact support (0 and
// 0-slope at rn>=2): flat-floored bowl (depression) + raised rim + fading ejecta, all (1-x^2)^2.
fn craterProfile(rn : f32, hp : ptr<function, f32>, dhp : ptr<function, f32>) {
    let RIM = 0.85; let RIMH = 0.22; let RW = 0.18; let FLOOR = -1.0;
    let EJH = 0.06; let EJC = 1.1; let EJW = 0.9;
    var h = 0.0; var d = 0.0;
    if (rn < RIM) {
        let u = rn / RIM; let s = u * u * (3.0 - 2.0 * u);
        h = h + FLOOR * (1.0 - s);
        d = d + FLOOR * (-(6.0 * u - 6.0 * u * u)) / RIM;
    }
    let x = (rn - RIM) / RW;
    if (abs(x) < 1.0) { let b = 1.0 - x * x; h = h + RIMH * b * b; d = d + RIMH * (-4.0 * x * b) / RW; }
    let xe = (rn - EJC) / EJW;
    if (abs(xe) < 1.0) { let be = 1.0 - xe * xe; h = h + EJH * be * be; d = d + EJH * (-4.0 * xe * be) / EJW; }
    *hp = h; *dhp = d;
}

// craterField(dir, radiusKm) -> vec4(height_km, dHeight/d(dir)). Sums all craters in the 3x3x3
// neighbourhood of each size class (overlapping bowls/ejecta superpose); support 2*r0 < 1 cell so
// 27 neighbours suffice. Bypasses the fbm normalization (heights are already in km).
fn craterField(dir : vec3<f32>, radiusKm : f32, camDistKm : f32, skipBig : bool) -> vec4<f32> {
    var H = 0.0; var G = vec3<f32>(0.0);
    for (var k = 0; k < CBT_CRATER_CLASSES; k = k + 1) {
        let prm = craterParams(k);
        // Band-limit by camera distance: big classes (large cell) keep fade=1 always; small
        // classes fade out when far (sub-pixel) -> recovers cost from altitude + no shimmer.
        let onKm = CBT_CRATER_RANGE * prm.x;
        let fade = 1.0 - smoothstep(onKm, onKm * 2.0, camDistKm);
        if (fade <= 0.0) { continue; }
        // skipBig (NORMAL path only): a crater much bigger than the camera distance has a far,
        // gradual wall -> ~flat locally -> drop it from the per-pixel gradient (keeps ~3 active
        // classes => 60 fps). The HEIGHT path passes skipBig=false so geometry/collision keep it.
        if (skipBig && camDistKm < prm.x * CBT_CRATER_NEAR) { continue; }
        let fk = radiusKm / prm.x;
        let P = dir * fk;
        let Pi = floor(P);
        var h = 0.0; var g = vec3<f32>(0.0);
        for (var dz = -1; dz <= 1; dz = dz + 1) {
        for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            let ci = Pi + vec3<f32>(f32(dx), f32(dy), f32(dz));
            let ix = i32(ci.x) & 255; let iy = i32(ci.y) & 255; let iz = i32(ci.z) & 255;
            let q0 = cbtPermAt(ix + cbtPermAt(iy + cbtPermAt(iz)));
            let rExist = f32(q0) * (1.0 / 256.0);
            if (rExist >= prm.w) { continue; }
            let q1 = cbtPermAt(ix + 1 + cbtPermAt(iy + cbtPermAt(iz)));
            let q2 = cbtPermAt(ix + cbtPermAt(iy + 1 + cbtPermAt(iz)));
            let jitter = vec3<f32>(f32(q0), f32(q1), f32(q2)) * (1.0 / 256.0);
            let rVar = f32(q1) * (1.0 / 256.0);
            let rSize = f32(q2) * (1.0 / 256.0);
            let center = ci + (vec3<f32>(0.15) + 0.7 * jitter);
            let r0e = prm.y * (0.8 + 0.4 * rSize);
            let depe = prm.z * CBT_CRATER_SCALE * (0.6 + 0.8 * rVar);
            let qd = P - center;
            let dist = sqrt(dot(qd, qd));
            let rn = dist / r0e;
            if (rn >= 2.0) { continue; }
            var hp : f32; var dhp : f32;
            craterProfile(rn, &hp, &dhp);
            h = h + depe * hp;
            if (dist > 1e-6 * r0e) { g = g + (depe * dhp / r0e) * (qd / dist); }
        }
        }
        }
        H = H + h * fade;
        G = G + g * (fk * fade);
    }
    return vec4<f32>(H, G);
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

// Distance-band-limited fbm. Returns vec4(height, dHeight/dp).
//
// EVERY octave (macro AND continued-detail) is gated by a per-octave camera-distance fade:
// a feature of wavelength wl(km) = radiusKm / freq is alive only while the camera is within
// ~CBT_DETAIL_RANGE wavelengths of it, fading out over the next octave of distance. This is a
// Nyquist band-limit in BOTH directions:
//   - far away, the fine octaves switch OFF before they project to sub-pixel, so neither the
//     height nor the analytic normal (this same gradient) carries sub-pixel ripple => no
//     shimmer / specular-style aliasing as you pull back,
//   - up close, the fine + detail octaves switch ON, so the ground gains relief.
// Big octaves have a huge onKm so they stay on until extreme distance (the planet keeps its
// shape) — only the unresolvable high end is dropped. maxMacro accumulates the UNFADED macro
// amps, so the normalization is fixed: at the surface (fade=1) the height equals the full
// macro field, so the CPU collision / other LOD backends still match. `camDistKm` is
// per-VERTEX (length of the camera-relative position) => a shared vertex gets one fade =>
// watertight, no cracks. f32 keeps the detail precise to ~20-30 m wavelength.
fn cbtFbm_d_at(p : vec3<f32>, camDistKm : f32, radiusKm : f32, craterSkipBig : bool) -> vec4<f32> {
    var sum : f32 = 0.0;
    var maxMacro : f32 = 0.0;
    var grad : vec3<f32> = vec3<f32>(0.0);
    var freq : f32 = CBT_BASE_FREQ;
    var amp : f32 = CBT_BASE_AMP;

    for (var i : i32 = 0; i < CBT_MAX_OCTAVES; i = i + 1) {
        if (i >= CBT_OCTAVES) { break; }
        let wlKm = radiusKm / freq;
        let onKm = CBT_DETAIL_RANGE * wlKm;
        let fade = 1.0 - smoothstep(onKm, onKm * 2.0, camDistKm);
        let sd = cbtSimplex3_d(p * freq);
        sum = sum + sd.x * (amp * fade);
        grad = grad + sd.yzw * (amp * freq * fade);
        // maxMacro takes the UNFADED amp -> normalization fixed, full macro at the surface.
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
    // Craters are the dominant relief (added AFTER fbm normalization; already in km). No distance
    // fade: they are macro landforms whose shape must be stable from orbit to ground.
    let cr = craterField(p, radiusKm, camDistKm, craterSkipBig);
    return vec4<f32>(sum * inv + cr.x, grad * inv + cr.yzw);
}

fn cbtFbmHeightAt(dir : vec3<f32>, camDistKm : f32, radiusKm : f32) -> f32 {
    // HEIGHT path: keep ALL crater classes (skipBig=false) so geometry is complete.
    return cbtFbm_d_at(dir, camDistKm, radiusKm, false).x;
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

    // NORMAL path: skipBig=true drops locally-flat huge craters from the per-pixel gradient (perf).
    let grad = cbtFbm_d_at(nrm, camDistKm, radius, true).yzw;
    let dhdt = dot(grad, tang);
    let dhdb = dot(grad, bitan);

    let sc = 1.0 / radius;
    let pn = nrm - dhdt * sc * tang - dhdb * sc * bitan;
    return normalize(pn);
}
