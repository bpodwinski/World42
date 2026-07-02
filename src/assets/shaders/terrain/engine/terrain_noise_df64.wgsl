// df64-DOMAIN simplex fbm — the §4.2 precision fix for centimetre terrain. The stock
// terrainSimplex3_d samples p*freq in f32, but at planet scale freq reaches ~1e9 so p*freq
// loses its fractional (cell) bits in f32 and the relief BANDS at ~1-30 m wavelength.
// Here the domain skew, the cell floor, the unskew offset and the cell-mod-256 (the
// permutation period) are all carried in df64 (~48 bit), so the cell coordinate stays
// accurate to ~cm at ANY frequency. Only the SMALL unskewed offsets p0..p3 (~[-1,1]) are
// narrowed to f32 for the gradient sum, which reuses the f32 terrainCorner/terrainPermAt/terrainGrad3.
//
// The accumulation (fades, maxMacro normalization, octave schedule) mirrors terrainFbm_d_at
// EXACTLY, so at coarse scales (where f32 did not band) the height matches the f32 field
// and the CPU collision mirror (terrain_noise.ts, native f64) still agrees.
//
// Requires terrain_f64.wgsl (df64 scalar + quick_two_sum) AND terrain_noise.wgsl (terrainCorner,
// terrainPermAt, the baked TERRAIN_* constants + TERRAIN_MAX_OCTAVES/TERRAIN_MAX_DETAIL) BEFORE this file.

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
fn terrainSimplex3_df64_d(px : vec2<f32>, py : vec2<f32>, pz : vec2<f32>) -> vec4<f32> {
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

    let gi0 = terrainPermAt(ix +          terrainPermAt(iy +          terrainPermAt(iz)));
    let gi1 = terrainPermAt(ix + e1i.x +  terrainPermAt(iy + e1i.y +  terrainPermAt(iz + e1i.z)));
    let gi2 = terrainPermAt(ix + e2i.x +  terrainPermAt(iy + e2i.y +  terrainPermAt(iz + e2i.z)));
    let gi3 = terrainPermAt(ix + 1 +      terrainPermAt(iy + 1 +      terrainPermAt(iz + 1)));

    terrainCorner(p0, gi0, &n, &grad);
    terrainCorner(p1, gi1, &n, &grad);
    terrainCorner(p2, gi2, &n, &grad);
    terrainCorner(p3, gi3, &n, &grad);

    return vec4<f32>(32.0 * n, 32.0 * grad);
}

// Distance-band-limited fbm with df64 domain — the df64 twin of terrainFbm_d_at. dir is the
// unit direction carried as df64 (dx, dy, dz). Same per-octave camera-distance fade and
// maxMacro normalization as the f32 version, so the surface is identical wherever f32 did
// not band, and finely resolved (cm) where it did.
// Two independently-normalized bands (ground-detail-v1.md Step 4b), mirroring terrainFbm_d_at's
// f32 twin: octaves < TERRAIN_MACRO_BAND_OCTAVES scale with TERRAIN_GLOBAL_AMP (macro landforms);
// the rest of the macro cascade AND all detail octaves form the fine band, scaling with the
// small, independent TERRAIN_DETAIL_AMP -- so Relief height can't amplify the highest
// frequencies into aliased "grain".
fn terrainFbm_d_at_df64(dx : vec2<f32>, dy : vec2<f32>, dz : vec2<f32>, camDistKm : f32, radiusKm : f32, craterSkipBig : bool) -> vec4<f32> {
    var sumMacro : f32 = 0.0;
    var maxMacro : f32 = 0.0;
    var gradMacro : vec3<f32> = vec3<f32>(0.0);
    var sumFine : f32 = 0.0;
    var maxFine : f32 = 0.0;
    var gradFine : vec3<f32> = vec3<f32>(0.0);
    var freq : f32 = TERRAIN_BASE_FREQ;
    var amp : f32 = TERRAIN_BASE_AMP;

    for (var i : i32 = 0; i < TERRAIN_MAX_OCTAVES; i = i + 1) {
        if (i >= TERRAIN_OCTAVES) { break; }
        let wlKm = radiusKm / freq;
        let onKm = TERRAIN_DETAIL_RANGE * wlKm;
        let fade = 1.0 - smoothstep(onKm, onKm * 2.0, camDistKm);
        let sd = terrainSimplex3_df64_d(df64_mul_f32(dx, freq), df64_mul_f32(dy, freq), df64_mul_f32(dz, freq));
        if (i < TERRAIN_MACRO_BAND_OCTAVES) {
            sumMacro = sumMacro + sd.x * (amp * fade);
            gradMacro = gradMacro + sd.yzw * (amp * freq * fade);
            maxMacro = maxMacro + amp;
        } else {
            sumFine = sumFine + sd.x * (amp * fade);
            gradFine = gradFine + sd.yzw * (amp * freq * fade);
            maxFine = maxFine + amp;
        }
        freq = freq * TERRAIN_LACUNARITY;
        amp = amp * TERRAIN_PERSISTENCE;
    }

    if (maxMacro <= 1e-12) {
        return vec4<f32>(0.0);
    }

    for (var j : i32 = 0; j < TERRAIN_MAX_DETAIL; j = j + 1) {
        if (j >= TERRAIN_DETAIL_OCTAVES) { break; }
        let wlKm = radiusKm / freq;
        let onKm = TERRAIN_DETAIL_RANGE * wlKm;
        let fade = 1.0 - smoothstep(onKm, onKm * 2.0, camDistKm);
        if (fade > 0.0) {
            let sd = terrainSimplex3_df64_d(df64_mul_f32(dx, freq), df64_mul_f32(dy, freq), df64_mul_f32(dz, freq));
            sumFine = sumFine + sd.x * (amp * fade);
            gradFine = gradFine + sd.yzw * (amp * freq * fade);
        }
        maxFine = maxFine + amp;
        freq = freq * TERRAIN_LACUNARITY;
        amp = amp * TERRAIN_PERSISTENCE;
    }

    let invMacro = TERRAIN_GLOBAL_AMP / maxMacro;
    var sum = sumMacro * invMacro;
    var grad = gradMacro * invMacro;
    if (maxFine > 1e-12) {
        let invFine = TERRAIN_DETAIL_AMP / maxFine;
        sum = sum + sumFine * invFine;
        grad = grad + gradFine * invFine;
    }
    // Craters (dominant relief). Crater cells are low-frequency (>= ~20 km) so f32 dir is exact at
    // crater scale — reuse the f32 craterField (from terrain_noise.wgsl, composed before this file) on
    // the narrowed unit dir. No distance fade (macro landforms). Added after fbm normalization.
    let cr = craterField(vec3<f32>(df64_to_f32(dx), df64_to_f32(dy), df64_to_f32(dz)), radiusKm, camDistKm, craterSkipBig, 0.0);
    return vec4<f32>(sum + cr.x, grad + cr.yzw);
}

fn terrainFbmHeightAt_df64(dx : vec2<f32>, dy : vec2<f32>, dz : vec2<f32>, camDistKm : f32, radiusKm : f32) -> f32 {
    // HEIGHT path (geometry): keep ALL crater classes (skipBig=false) so the shape is complete.
    return terrainFbm_d_at_df64(dx, dy, dz, camDistKm, radiusKm, false).x;
}
