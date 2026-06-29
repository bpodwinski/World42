import { describe, it, expect } from 'vitest';
import {
    df64FromNumber,
    df64ToNumber,
    df64ToF32,
    df64Add,
    df64Sub,
    df64Mul,
    df64MulF32,
    df64Recip,
    df64Div,
    df64InvSqrt,
    df64Sqrt,
    type DF64
} from './ocbt_f64';

const f = Math.fround;

/** Seeded LCG yielding doubles in [-scale, scale] (no Math.random). */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
function spread(r: () => number, scale: number): number {
    return (r() * 2 - 1) * scale;
}

/** df64 result is accurate to ~48 bits, so ~1e-13 relative is a safe gate. */
const REL = 1e-13;
function expectClose(got: number, want: number, rel = REL): void {
    const tol = rel * Math.max(1, Math.abs(want));
    expect(Math.abs(got - want)).toBeLessThanOrEqual(tol);
}

describe('ocbt_f64 — representation', () => {
    it('round-trips a plain f32 exactly', () => {
        for (const x of [0, 1, -1, 0.5, 1234.5, f(Math.PI)]) {
            const d = df64FromNumber(x);
            expect(df64ToNumber(d)).toBe(x);
        }
    });

    it('retains precision a single f32 would lose', () => {
        // 1 + 2^-30 is not f32-representable: fround collapses it to 1.0.
        const x = 1 + 2 ** -30;
        expect(f(x)).toBe(1); // plain f32 loses the increment entirely
        const d = df64FromNumber(x);
        expectClose(df64ToNumber(d), x, 1e-15); // df64 keeps it
        expect(df64ToNumber(d)).not.toBe(1);
    });

    it('narrows to f32 as the final decode step', () => {
        const d = df64FromNumber(Math.PI);
        expect(df64ToF32(d)).toBe(f(Math.PI));
    });
});

describe('ocbt_f64 — add / sub / mul vs host double', () => {
    it('matches host arithmetic across magnitudes', () => {
        const r = rng(0xc0ffee);
        for (let i = 0; i < 4000; i++) {
            const scale = [1, 1e3, 1e6, 1e-3][i & 3];
            const av = spread(r, scale);
            const bv = spread(r, scale);
            const a = df64FromNumber(av);
            const b = df64FromNumber(bv);
            // Reference uses the df64-rounded inputs so we measure op error, not
            // the input-conversion error.
            const ar = df64ToNumber(a);
            const br = df64ToNumber(b);
            expectClose(df64ToNumber(df64Add(a, b)), ar + br);
            expectClose(df64ToNumber(df64Sub(a, b)), ar - br);
            expectClose(df64ToNumber(df64Mul(a, b)), ar * br);
        }
    });

    it('df64MulF32 matches df64 * scalar', () => {
        const r = rng(0x1234);
        for (let i = 0; i < 2000; i++) {
            const a = df64FromNumber(spread(r, 1e4));
            const s = f(spread(r, 10));
            const ar = df64ToNumber(a);
            expectClose(df64ToNumber(df64MulF32(a, s)), ar * s);
        }
    });

    it('catches the cancellation a single f32 cannot represent', () => {
        // (1 + e) - 1 == e for e well below the f32 epsilon.
        const e = 2 ** -40;
        const one: DF64 = df64FromNumber(1);
        const onePlus = df64Add(one, df64FromNumber(e));
        const diff = df64Sub(onePlus, one);
        expectClose(df64ToNumber(diff), e, 1e-6);
        // The naive f32 path gives exactly zero.
        expect(f(f(1 + e) - 1)).toBe(0);
    });
});

describe('ocbt_f64 — recip / div / invsqrt / sqrt vs host double', () => {
    const r = rng(0xabcdef);
    it('recip and div match host', () => {
        for (let i = 0; i < 3000; i++) {
            let bv = spread(r, 1e3);
            if (Math.abs(bv) < 1e-3) bv = 1; // avoid degenerate divisors
            const av = spread(r, 1e3);
            const a = df64FromNumber(av);
            const b = df64FromNumber(bv);
            const ar = df64ToNumber(a);
            const br = df64ToNumber(b);
            expectClose(df64ToNumber(df64Recip(b)), 1 / br, 1e-12);
            expectClose(df64ToNumber(df64Div(a, b)), ar / br, 1e-12);
        }
    });

    it('invsqrt and sqrt match host for positive inputs', () => {
        for (let i = 0; i < 3000; i++) {
            const av = Math.abs(spread(r, 1e6)) + 1e-3;
            const a = df64FromNumber(av);
            const ar = df64ToNumber(a);
            expectClose(df64ToNumber(df64InvSqrt(a)), 1 / Math.sqrt(ar), 1e-12);
            expectClose(df64ToNumber(df64Sqrt(a)), Math.sqrt(ar), 1e-12);
        }
        expect(df64ToNumber(df64Sqrt(df64FromNumber(0)))).toBe(0);
    });

    it('normalizes a near-unit vector (the LEB decode use case)', () => {
        // v = (0.6, 0.8, tiny): length ~1; df64 normalize should land on the sphere.
        const vx = df64FromNumber(0.6);
        const vy = df64FromNumber(0.8);
        const vz = df64FromNumber(3e-7);
        const lenSq = df64Add(
            df64Add(df64Mul(vx, vx), df64Mul(vy, vy)),
            df64Mul(vz, vz)
        );
        const inv = df64InvSqrt(lenSq);
        const nx = df64ToNumber(df64Mul(vx, inv));
        const ny = df64ToNumber(df64Mul(vy, inv));
        const nz = df64ToNumber(df64Mul(vz, inv));
        expectClose(nx * nx + ny * ny + nz * nz, 1, 1e-12);
    });
});
