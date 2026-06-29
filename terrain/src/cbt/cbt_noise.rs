//! Bit-exact Rust port of the custom Gustavson 3D simplex + FBM used by the CBT
//! terrain (src/systems/lod/cbt/cbt_noise.ts). This is the field driving the CBT
//! radial displacement; it MUST match the TS field (and the per-pixel-normal GLSL
//! shader `_cbtNoise.glsl`, which mirrors the same algorithm), otherwise the GPU
//! normals would no longer line up with the relief.
//!
//! Every operation in the height field is `+`, `*`, `floor`, `&`, `%` on f64/int —
//! no transcendentals — so the result is reproducible bit-for-bit against
//! JavaScript (validated by the fixture test below). Do NOT substitute the
//! `noise` crate's OpenSimplex here (that is a different field, used only by
//! build_chunk for CDLOD).

/// Noise field params — mirrors `NoiseParams` in cbt_noise.ts.
#[derive(Clone, Copy, Debug)]
pub struct NoiseParams {
    pub seed: i32,
    pub octaves: u32,
    pub base_frequency: f64,
    pub base_amplitude: f64,
    pub lacunarity: f64,
    pub persistence: f64,
    pub global_amplitude: f64,
}

// Gradient table (12 edges of a cube) — identical to GRAD3 in cbt_noise.ts.
const GRAD3: [[f64; 3]; 12] = [
    [1.0, 1.0, 0.0],
    [-1.0, 1.0, 0.0],
    [1.0, -1.0, 0.0],
    [-1.0, -1.0, 0.0],
    [1.0, 0.0, 1.0],
    [-1.0, 0.0, 1.0],
    [1.0, 0.0, -1.0],
    [-1.0, 0.0, -1.0],
    [0.0, 1.0, 1.0],
    [0.0, -1.0, 1.0],
    [0.0, 1.0, -1.0],
    [0.0, -1.0, -1.0],
];

const F3: f64 = 1.0 / 3.0;
const G3: f64 = 1.0 / 6.0;

/// Seeded permutation table (512 entries, duplicated for wrapping). Reproduces
/// the JS Fisher–Yates with the LCG `s = (s*1664525 + 1013904223) | 0` and index
/// `(s >>> 0) % (i+1)`. `wrapping_*` on i32 == JS `| 0` because the exact product
/// always fits in f64 (< 2^53), so both reduce mod 2^32.
pub fn build_perm(seed: i32) -> [u8; 512] {
    let mut p = [0u8; 512];
    for i in 0..256 {
        p[i] = i as u8;
    }
    let mut s: i32 = seed; // JS: seed | 0 — identity for an i32
    let mut i: i32 = 255;
    while i > 0 {
        s = s.wrapping_mul(1664525).wrapping_add(1013904223);
        let j = ((s as u32) % ((i as u32) + 1)) as usize;
        p.swap(i as usize, j);
        i -= 1;
    }
    for i in 0..256 {
        p[i + 256] = p[i];
    }
    p
}

#[inline]
fn dot3(g: &[f64; 3], x: f64, y: f64, z: f64) -> f64 {
    g[0] * x + g[1] * y + g[2] * z
}

/// 3D simplex noise, range ~[-1, 1]. Bit-exact port of `simplex3`.
pub fn simplex3(perm: &[u8; 512], x: f64, y: f64, z: f64) -> f64 {
    let s = (x + y + z) * F3;
    let i = (x + s).floor();
    let j = (y + s).floor();
    let k = (z + s).floor();

    let t = (i + j + k) * G3;
    let x0 = x - (i - t);
    let y0 = y - (j - t);
    let z0 = z - (k - t);

    // (i1,j1,k1, i2,j2,k2) — simplex corner offsets, same branch order as JS.
    let (i1, j1, k1, i2, j2, k2): (f64, f64, f64, f64, f64, f64) = if x0 >= y0 {
        if y0 >= z0 {
            (1.0, 0.0, 0.0, 1.0, 1.0, 0.0)
        } else if x0 >= z0 {
            (1.0, 0.0, 0.0, 1.0, 0.0, 1.0)
        } else {
            (0.0, 0.0, 1.0, 1.0, 0.0, 1.0)
        }
    } else if y0 < z0 {
        (0.0, 0.0, 1.0, 0.0, 1.0, 1.0)
    } else if x0 < z0 {
        (0.0, 1.0, 0.0, 0.0, 1.0, 1.0)
    } else {
        (0.0, 1.0, 0.0, 1.0, 1.0, 0.0)
    };

    let x1 = x0 - i1 + G3;
    let y1 = y0 - j1 + G3;
    let z1 = z0 - k1 + G3;
    let x2 = x0 - i2 + 2.0 * G3;
    let y2 = y0 - j2 + 2.0 * G3;
    let z2 = z0 - k2 + 2.0 * G3;
    let x3 = x0 - 1.0 + 3.0 * G3;
    let y3 = y0 - 1.0 + 3.0 * G3;
    let z3 = z0 - 1.0 + 3.0 * G3;

    // JS `i & 255` is ToInt32(i) & 255; for our integer-valued, in-range floors
    // `(i as i64) & 255` produces the identical low byte (incl. negative wrap).
    let ii = ((i as i64) & 255) as usize;
    let jj = ((j as i64) & 255) as usize;
    let kk = ((k as i64) & 255) as usize;

    let i1i = i1 as usize;
    let j1i = j1 as usize;
    let k1i = k1 as usize;
    let i2i = i2 as usize;
    let j2i = j2 as usize;
    let k2i = k2 as usize;

    let mut n = 0.0;

    let mut t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if t0 > 0.0 {
        t0 *= t0;
        let gi0 = (perm[ii + perm[jj + perm[kk] as usize] as usize] as usize) % 12;
        n += t0 * t0 * dot3(&GRAD3[gi0], x0, y0, z0);
    }

    let mut t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if t1 > 0.0 {
        t1 *= t1;
        let gi1 = (perm[ii + i1i + perm[jj + j1i + perm[kk + k1i] as usize] as usize]
            as usize)
            % 12;
        n += t1 * t1 * dot3(&GRAD3[gi1], x1, y1, z1);
    }

    let mut t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if t2 > 0.0 {
        t2 *= t2;
        let gi2 = (perm[ii + i2i + perm[jj + j2i + perm[kk + k2i] as usize] as usize]
            as usize)
            % 12;
        n += t2 * t2 * dot3(&GRAD3[gi2], x2, y2, z2);
    }

    let mut t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if t3 > 0.0 {
        t3 *= t3;
        let gi3 =
            (perm[ii + 1 + perm[jj + 1 + perm[kk + 1] as usize] as usize] as usize) % 12;
        n += t3 * t3 * dot3(&GRAD3[gi3], x3, y3, z3);
    }

    32.0 * n
}

/// FBM in ~[-globalAmplitude, +globalAmplitude]. Bit-exact port of `fbmNoise`.
/// The caller supplies the prebuilt perm table (the TS side caches by seed).
pub fn fbm_noise(perm: &[u8; 512], x: f64, y: f64, z: f64, params: &NoiseParams) -> f64 {
    let mut sum = 0.0;
    let mut max_possible = 0.0;
    let mut freq = params.base_frequency;
    let mut amp = params.base_amplitude;

    for _ in 0..params.octaves {
        sum += simplex3(perm, x * freq, y * freq, z * freq) * amp;
        max_possible += amp;
        freq *= params.lacunarity;
        amp *= params.persistence;
    }

    if max_possible > 1e-12 {
        (sum / max_possible) * params.global_amplitude
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/cbt_noise_fixture.txt");

    fn f64_from_hex(h: &str) -> f64 {
        f64::from_bits(u64::from_str_radix(h, 16).expect("hex bits"))
    }

    /// Validates buildPerm + fbmNoise against the bit-exact fixture dumped from
    /// the real TypeScript implementation (terrain/tools/gen_noise_fixture.ts).
    #[test]
    fn matches_typescript_fixture_bit_for_bit() {
        // paramIdx -> (params, perm)
        let mut params: Vec<NoiseParams> = Vec::new();
        let mut perms: Vec<[u8; 512]> = Vec::new();
        let mut noise_samples = 0usize;
        let mut perm_tables = 0usize;

        for line in FIXTURE.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut it = line.split_whitespace();
            match it.next().unwrap() {
                "P" => {
                    let idx: usize = it.next().unwrap().parse().unwrap();
                    let seed: i32 = it.next().unwrap().parse().unwrap();
                    let octaves: u32 = it.next().unwrap().parse().unwrap();
                    let base_frequency = f64_from_hex(it.next().unwrap());
                    let base_amplitude = f64_from_hex(it.next().unwrap());
                    let lacunarity = f64_from_hex(it.next().unwrap());
                    let persistence = f64_from_hex(it.next().unwrap());
                    let global_amplitude = f64_from_hex(it.next().unwrap());
                    let p = NoiseParams {
                        seed,
                        octaves,
                        base_frequency,
                        base_amplitude,
                        lacunarity,
                        persistence,
                        global_amplitude,
                    };
                    assert_eq!(idx, params.len(), "param sets must be in order");
                    params.push(p);
                    perms.push(build_perm(seed));
                }
                "N" => {
                    let idx: usize = it.next().unwrap().parse().unwrap();
                    let x = f64_from_hex(it.next().unwrap());
                    let y = f64_from_hex(it.next().unwrap());
                    let z = f64_from_hex(it.next().unwrap());
                    let expected = f64_from_hex(it.next().unwrap());
                    let got = fbm_noise(&perms[idx], x, y, z, &params[idx]);
                    assert_eq!(
                        got.to_bits(),
                        expected.to_bits(),
                        "fbm mismatch param={idx} x={x} y={y} z={z}: got {got} ({:#018x}) expected {expected} ({:#018x})",
                        got.to_bits(),
                        expected.to_bits()
                    );
                    noise_samples += 1;
                }
                "M" => {
                    let seed: i32 = it.next().unwrap().parse().unwrap();
                    let built = build_perm(seed);
                    for (k, tok) in it.enumerate() {
                        let v: u8 = tok.parse().unwrap();
                        assert_eq!(built[k], v, "perm mismatch seed={seed} index={k}");
                    }
                    perm_tables += 1;
                }
                other => panic!("unknown fixture line kind: {other}"),
            }
        }

        assert!(noise_samples > 0, "fixture had no noise samples");
        assert!(perm_tables > 0, "fixture had no perm tables");
    }
}
