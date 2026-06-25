// Proves the §4.2 fix: the simplex noise INPUT (cell index + unskewed offset — the only
// thing the gradient sum depends on) collapses for two cm-apart directions when the
// domain p*freq is carried in f32 (the banding bug), but is correctly resolved when it is
// carried in df64 (the fix), matching the native-f64 reference. Same skew math as
// cbt_noise_df64.wgsl / cbt_noise.ts simplex3 — only the domain precision differs.
import { describe, it, expect } from 'vitest';
import {
    df64FromNumber,
    df64ToNumber,
    df64Add,
    df64Sub,
    df64MulF32,
    type DF64
} from './ocbt_f64';

const F3 = 1 / 3;
const G3 = 1 / 6;
const fr = Math.fround;

// Native-f64 simplex cell+offset (the truth) from an already-scaled domain point.
function cellF64(x: number, y: number, z: number) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    return { cell: [i & 255, j & 255, k & 255], p0: [x - (i - t), y - (j - t), z - (k - t)] };
}

// df64-domain cell+offset — TS mirror of cbtSimplex3_df64_d's skew block.
function df64Floor(a: DF64): DF64 {
    const hi = fr(Math.floor(a[0]));
    if (hi === a[0]) {
        // quick_two_sum(hi, floor(a.lo))
        const lo = fr(Math.floor(a[1]));
        const s = fr(hi + lo);
        return [s, fr(lo - fr(s - hi))];
    }
    return [hi, 0];
}
function df64Mod256(a: DF64): number {
    const q = df64Floor(df64MulF32(a, 1 / 256));
    return df64ToNumber(df64Sub(a, df64MulF32(q, 256)));
}
function cellDf64(px: DF64, py: DF64, pz: DF64) {
    const s = df64MulF32(df64Add(df64Add(px, py), pz), F3);
    const ix = df64Floor(df64Add(px, s));
    const iy = df64Floor(df64Add(py, s));
    const iz = df64Floor(df64Add(pz, s));
    const t = df64MulF32(df64Add(df64Add(ix, iy), iz), G3);
    return {
        cell: [df64Mod256(ix), df64Mod256(iy), df64Mod256(iz)],
        p0: [
            df64ToNumber(df64Sub(px, df64Sub(ix, t))),
            df64ToNumber(df64Sub(py, df64Sub(iy, t))),
            df64ToNumber(df64Sub(pz, df64Sub(iz, t)))
        ]
    };
}

const RKM = 6371;
const norm = (v: number[]) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
};

describe('§4.2 df64 noise domain — resolves cm where f32 bands', () => {
    it('two cm-apart dirs: f32 domain gives an IDENTICAL noise cell+offset (banding); df64 resolves it', () => {
        // A fine detail octave: baseFreq 6, lacunarity 2.2, ~25 octaves deep -> freq ~1e8,
        // wavelength ~ R/freq ~ 6e-5 km ~ 6 cm. This is exactly where f32 must band.
        const freq = 6 * Math.pow(2.2, 25); // ~1.0e8
        const d1 = norm([0.3, 0.7, 0.5]);
        // tangent step of 1 cm on the surface: dθ = 0.01 m / R(m)
        const dThetaCm = 0.01 / (RKM * 1000);
        const tan = norm([-d1[1], d1[0], 0]); // a unit tangent
        const d2 = norm([d1[0] + dThetaCm * tan[0], d1[1] + dThetaCm * tan[1], d1[2] + dThetaCm * tan[2]]);

        // --- f32 domain: p = fround(fround(dir) * freq), as the GPU did before §4.2.
        const f32dom = (d: number[]) =>
            cellF64(fr(fr(d[0]) * freq), fr(fr(d[1]) * freq), fr(fr(d[2]) * freq));
        const a = f32dom(d1);
        const b = f32dom(d2);
        // BANDING: the two cm-apart points map to the SAME simplex cell AND the SAME
        // unskewed offset -> byte-identical noise value. (the bug §4.2 fixes)
        expect(b.cell).toEqual(a.cell);
        expect(b.p0[0]).toBe(a.p0[0]);
        expect(b.p0[1]).toBe(a.p0[1]);
        expect(b.p0[2]).toBe(a.p0[2]);

        // --- df64 domain: p = df64(dir) * freq, as §4.2 does now.
        const df64dom = (d: number[]) =>
            cellDf64(
                df64MulF32(df64FromNumber(d[0]), freq),
                df64MulF32(df64FromNumber(d[1]), freq),
                df64MulF32(df64FromNumber(d[2]), freq)
            );
        const c = df64dom(d1);
        const e = df64dom(d2);
        // RESOLVED: the df64 offset moves between the two points (no banding). The true
        // domain step is freq*dTheta ~ 0.16, far above the df64 noise floor.
        const dP0 = Math.hypot(e.p0[0] - c.p0[0], e.p0[1] - c.p0[1], e.p0[2] - c.p0[2]);
        expect(dP0).toBeGreaterThan(0.05);

        // --- df64 == native f64 (correctness of the df64 skew): same cell + offset.
        const truth = (d: number[]) => cellF64(d[0] * freq, d[1] * freq, d[2] * freq);
        for (const d of [d1, d2]) {
            const want = truth(d);
            const got = df64dom(d);
            expect(got.cell).toEqual(want.cell);
            expect(Math.hypot(got.p0[0] - want.p0[0], got.p0[1] - want.p0[1], got.p0[2] - want.p0[2])).toBeLessThan(1e-4);
        }
    });
});
