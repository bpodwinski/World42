/**
 * Double-single ("df64") floating point — the CPU mirror of `terrain_f64.wgsl`.
 *
 * WGSL has no f64, but at terrain depth ~60 a position decoded from an LEB matrix
 * loses precision in plain f32 long before the leaf is reached (a unit sphere at
 * depth 60 needs ~60 fractional bits; f32 has 24). The reference does the decode in
 * native `double` (`double_math.hlsl`); WGSL must emulate it. We use the classic
 * unevaluated-sum representation: a value is `hi + lo` stored as two f32 lanes with
 * `|lo| <= 0.5 ulp(hi)`, giving ~2*24 = ~48 bits of mantissa — enough to decode a
 * patch relative to the camera (floating-origin) at depth ~60, then narrow to f32.
 *
 * This is NOT a line-by-line port of `double_math.hlsl` (that file assumes a real
 * f64 type); it is the standard error-free-transform df64 algebra (Dekker / Thall),
 * which is what an f64-less GPU needs. It is the golden oracle: `terrain_f64.test.ts`
 * checks every op against the host FP64 result, and later phases cross-check the GPU
 * decode against values produced here.
 *
 * Faithful-to-WGSL detail: f32 has no fused multiply-add, so every intermediate is
 * rounded to f32 via `Math.fround`. The one exception is `twoProd`, where the exact
 * product of two f32 values has <= 48 significant bits and is therefore EXACT in a
 * host double — that exactness is what lets us recover the rounding error, and it
 * matches WGSL's `fma(a, b, -p)` bit for bit.
 */

/** A df64 value as `[hi, lo]`, two f32 lanes with `value == hi + lo`. */
export type DF64 = readonly [number, number];

const f = Math.fround;

/** df64 from a host number (rounds to the nearest df64). */
export function df64FromNumber(x: number): DF64 {
    const hi = f(x);
    // Residual of the f32 rounding; representable in f32 for any finite x.
    const lo = f(x - hi);
    return [hi, lo];
}

/** Real value of a df64 (host double — used for tests and final narrowing). */
export function df64ToNumber(a: DF64): number {
    return a[0] + a[1];
}

/** Narrow a df64 back to a single f32 (the EvaluateLEB output step). */
export function df64ToF32(a: DF64): number {
    return f(a[0] + a[1]);
}

export function df64Neg(a: DF64): DF64 {
    return [-a[0], -a[1]];
}

/** Error-free sum of two f32: returns `[s, e]` with `s = fl(a+b)`, `a+b == s+e`. */
function twoSum(a: number, b: number): [number, number] {
    const s = f(a + b);
    const v = f(s - a);
    const e = f(f(a - f(s - v)) + f(b - v));
    return [s, e];
}

/** Fast error-free sum, valid when `|a| >= |b|`. */
function quickTwoSum(a: number, b: number): [number, number] {
    const s = f(a + b);
    const e = f(b - f(s - a));
    return [s, e];
}

/**
 * Error-free product of two f32: `[p, e]` with `p = fl(a*b)`, `a*b == p+e`.
 * The exact product fits in a host double, so `a*b - p` is computed exactly —
 * this is the analogue of WGSL `fma(a, b, -p)`.
 */
function twoProd(a: number, b: number): [number, number] {
    const p = f(a * b);
    const e = f(a * b - p);
    return [p, e];
}

export function df64Add(a: DF64, b: DF64): DF64 {
    let [sh, sl] = twoSum(a[0], b[0]);
    const [th, tl] = twoSum(a[1], b[1]);
    sl = f(sl + th);
    [sh, sl] = quickTwoSum(sh, sl);
    sl = f(sl + tl);
    return quickTwoSum(sh, sl);
}

export function df64Sub(a: DF64, b: DF64): DF64 {
    return df64Add(a, df64Neg(b));
}

export function df64Mul(a: DF64, b: DF64): DF64 {
    const [ph, pl0] = twoProd(a[0], b[0]);
    const pl = f(pl0 + f(f(a[0] * b[1]) + f(a[1] * b[0])));
    return quickTwoSum(ph, pl);
}

/** df64 * f32 scalar (cheaper than the full df64*df64). */
export function df64MulF32(a: DF64, s: number): DF64 {
    const [ph, pl0] = twoProd(a[0], s);
    const pl = f(pl0 + f(a[1] * s));
    return quickTwoSum(ph, pl);
}

/** Reciprocal 1/a via Newton refinement on an f32 seed. */
export function df64Recip(a: DF64): DF64 {
    let x: DF64 = [f(1 / a[0]), 0];
    const two: DF64 = [2, 0];
    for (let i = 0; i < 3; i++) {
        // x = x * (2 - a*x)
        x = df64Mul(x, df64Sub(two, df64Mul(a, x)));
    }
    return x;
}

export function df64Div(a: DF64, b: DF64): DF64 {
    return df64Mul(a, df64Recip(b));
}

/** Inverse square root 1/sqrt(a) via Newton refinement on an f32 seed. */
export function df64InvSqrt(a: DF64): DF64 {
    let x: DF64 = [f(1 / Math.sqrt(a[0])), 0];
    const half: DF64 = df64MulF32(a, 0.5);
    const oneAndHalf: DF64 = [1.5, 0];
    for (let i = 0; i < 3; i++) {
        // x = x * (1.5 - (0.5*a) * x*x)
        const t = df64Mul(df64Mul(x, x), half);
        x = df64Mul(x, df64Sub(oneAndHalf, t));
    }
    return x;
}

export function df64Sqrt(a: DF64): DF64 {
    if (a[0] <= 0) return [0, 0];
    return df64Mul(a, df64InvSqrt(a));
}
