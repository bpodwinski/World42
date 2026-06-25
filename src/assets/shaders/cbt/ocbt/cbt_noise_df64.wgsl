// df64-DOMAIN simplex fbm — the §4.2 precision fix for centimetre terrain. The stock
// cbtSimplex3_d samples p*freq in f32, but at planet scale freq reaches ~1e9 so p*freq
// loses its fractional (cell) bits in f32 and the relief BANDS at ~1-30 m wavelength.
// Here the domain skew, the cell floor, the unskew offset and the cell-mod-256 (the
// permutation period) are all carried in df64 (~48 bit), so the cell coordinate stays
// accurate to ~cm at ANY frequency. Only the SMALL unskewed offsets p0..p3 (~[-1,1]) are
// narrowed to f32 for the gradient sum, which reuses the f32 cbtCorner/cbtPermAt/cbtGrad3.
//
// The accumulation (fades, maxMacro normalization, octave schedule) mirrors cbtFbm_d_at
// EXACTLY, so at coarse scales (where f32 did not band) the height matches the f32 field
// and the CPU collision mirror (cbt_noise.ts, native f64) still agrees.
//
// Requires ocbt_f64.wgsl (df64 scalar + quick_two_sum) AND cbt_noise.wgsl (cbtCorner,
// cbtPermAt, the baked CBT_* constants + CBT_MAX_OCTAVES/CBT_MAX_DETAIL) BEFORE this file.

// Largest integer <= a, in df64 (QD floor: floor the hi part, refine with the lo when
// the hi part is already integral — which it is for the huge integer cells at planet
// scale, where a.x is a multiple of its ulp).
fn df64_floor(a : vec2<f32>) -> vec2<f32> {
    let hi = floor(a.x);
    if (hi == a.x) {
        return quick_two_sum(hi, floor(a.y));
    }
    return vec2<f32>(hi, 0.0);
}

// Exact integer-cell modulo 256 (the permutation period) of a df64 integer. Result in
// [0, 256). Matches i32(cell) & 255 including for negative cells.
fn df64_mod256(a : vec2<f32>) -> f32 {
    let aOver = df64_mul_f32(a, 1.0 / 256.0); // exact, 256 is a power of two
    let q = df64_floor(aOver);
    let m = df64_sub(a, df64_mul_f32(q, 256.0));
    return df64_to_f32(m);
}

// Gustavson 3D simplex with analytic gradient, df64 DOMAIN. Inputs are the per-axis
// scaled domain coordinate (p*freq) carried as df64. Returns vec4(value, d/dp.xyz) in f32.
fn cbtSimplex3_df64_d(px : vec2<f32>, py : vec2<f32>, pz : vec2<f32>) -> vec4<f32> {
    let F3 = 1.0 / 3.0;
    let G3 = 1.0 / 6.0;

    let s = df64_mul_f32(df64_add(df64_add(px, py), pz), F3);
    let ix_df = df64_floor(df64_add(px, s));
    let iy_df = df64_floor(df64_add(py, s));
    let iz_df = df64_floor(df64_add(pz, s));
    let t = df64_mul_f32(df64_add(df64_add(ix_df, iy_df), iz_df), G3);

    // p0 = p - (ijk - t): the small unskewed offset, recovered by df64 cancellation of
    // the huge p and ijk, then narrowed to f32 (it is ~[-1, 1]).
    let p0 = vec3<f32>(
        df64_to_f32(df64_sub(px, df64_sub(ix_df, t))),
        df64_to_f32(df64_sub(py, df64_sub(iy_df, t))),
        df64_to_f32(df64_sub(pz, df64_sub(iz_df, t)))
    );

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

    let ix = i32(df64_mod256(ix_df));
    let iy = i32(df64_mod256(iy_df));
    let iz = i32(df64_mod256(iz_df));
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

// Distance-band-limited fbm with df64 domain — the df64 twin of cbtFbm_d_at. dir is the
// unit direction carried as df64 (dx, dy, dz). Same per-octave camera-distance fade and
// maxMacro normalization as the f32 version, so the surface is identical wherever f32 did
// not band, and finely resolved (cm) where it did.
fn cbtFbm_d_at_df64(dx : vec2<f32>, dy : vec2<f32>, dz : vec2<f32>, camDistKm : f32, radiusKm : f32) -> vec4<f32> {
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
        let sd = cbtSimplex3_df64_d(df64_mul_f32(dx, freq), df64_mul_f32(dy, freq), df64_mul_f32(dz, freq));
        sum = sum + sd.x * (amp * fade);
        grad = grad + sd.yzw * (amp * freq * fade);
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
            let sd = cbtSimplex3_df64_d(df64_mul_f32(dx, freq), df64_mul_f32(dy, freq), df64_mul_f32(dz, freq));
            sum = sum + sd.x * (amp * fade);
            grad = grad + sd.yzw * (amp * freq * fade);
        }
        freq = freq * CBT_LACUNARITY;
        amp = amp * CBT_PERSISTENCE;
    }

    let inv = CBT_GLOBAL_AMP / maxMacro;
    return vec4<f32>(sum * inv, grad * inv);
}

fn cbtFbmHeightAt_df64(dx : vec2<f32>, dy : vec2<f32>, dz : vec2<f32>, camDistKm : f32, radiusKm : f32) -> f32 {
    return cbtFbm_d_at_df64(dx, dy, dz, camDistKm, radiusKm).x;
}

// Per-pixel surface normal from the df64-DOMAIN fbm gradient — the df64 twin of
// cbtNoiseNormalAt (cbt_noise.wgsl). Inputs are the WORLD-ANCHORED unit direction as
// df64 (dx, dy, dz), so the macro+detail relief is resolved to ~cm near the ground where
// the f32 normal banded (~1-30 m). Mirrors the f32 projection exactly: project the
// gradient onto the sphere tangent basis and tilt the unit normal. Reuses the f32
// cbtSphereTangents (the basis only needs the unit normal, which is well-conditioned).
fn cbtNoiseNormalAt_df64(dx : vec2<f32>, dy : vec2<f32>, dz : vec2<f32>, radius : f32, camDistKm : f32) -> vec3<f32> {
    let nrm = normalize(vec3<f32>(df64_to_f32(dx), df64_to_f32(dy), df64_to_f32(dz)));
    var tang : vec3<f32>;
    var bitan : vec3<f32>;
    cbtSphereTangents(nrm, &tang, &bitan);

    let grad = cbtFbm_d_at_df64(dx, dy, dz, camDistKm, radius).yzw;
    let dhdt = dot(grad, tang);
    let dhdb = dot(grad, bitan);

    let sc = 1.0 / radius;
    let pn = nrm - dhdt * sc * tang - dhdb * sc * bitan;
    return normalize(pn);
}

// Extra high-frequency micro-relief gradient for the near-ground band (df64 domain, so
// the very high freq on the unit dir does NOT band as it would in f32). `baseFreq` is the
// first octave's frequency on the unit direction (= radius / wavelength); octaves double
// the freq and halve the amplitude (persistence 0.5), matching the legacy detail hack.
// Returns the accumulated noise gradient (domain units); the caller projects + tilts it.
fn cbtGroundDetailGrad_df64(dx : vec2<f32>, dy : vec2<f32>, dz : vec2<f32>, baseFreq : f32, octaves : i32) -> vec3<f32> {
    var grad : vec3<f32> = vec3<f32>(0.0);
    var freq : f32 = baseFreq;
    var amp : f32 = 1.0;
    for (var i : i32 = 0; i < octaves; i = i + 1) {
        let sd = cbtSimplex3_df64_d(df64_mul_f32(dx, freq), df64_mul_f32(dy, freq), df64_mul_f32(dz, freq));
        grad = grad + sd.yzw * amp;
        freq = freq * 2.0;
        amp = amp * 0.5;
    }
    return grad;
}
