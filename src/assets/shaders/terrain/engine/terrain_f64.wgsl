// Double-single ("df64") floating point for the TERRAIN path. WGSL has no f64, but at
// terrain depth ~60 a position decoded from an LEB matrix needs ~60 fractional bits
// while f32 has 24. A df64 value is carried as vec2<f32> = (hi, lo) with
// value == hi + lo and |lo| <= 0.5 ulp(hi), giving ~48 bits of mantissa — enough to
// decode a patch relative to the camera (floating-origin) at depth ~60, then narrow
// to f32 for the vertex buffer.
//
// Mirrors src/systems/lod/terrain/gpu/terrain_f64.ts EXACTLY. This is the standard
// error-free-transform algebra (Dekker / Thall), the f64-less analogue of the
// reference double_math.hlsl. f32 here HAS a fused multiply-add (WGSL fma), which is
// what makes twoProd exact.

fn df64_from_f32(x : f32) -> vec2<f32> {
    return vec2<f32>(x, 0.0);
}

// Narrow a df64 back to a single f32 (the EvaluateLEB output step).
fn df64_to_f32(a : vec2<f32>) -> f32 {
    return a.x + a.y;
}

fn df64_neg(a : vec2<f32>) -> vec2<f32> {
    return -a;
}

// Error-free sum of two f32: result.x = fl(a+b), a+b == result.x + result.y.
fn two_sum(a : f32, b : f32) -> vec2<f32> {
    let s = a + b;
    let v = s - a;
    let e = (a - (s - v)) + (b - v);
    return vec2<f32>(s, e);
}

// Fast error-free sum, valid when |a| >= |b|.
fn quick_two_sum(a : f32, b : f32) -> vec2<f32> {
    let s = a + b;
    let e = b - (s - a);
    return vec2<f32>(s, e);
}

// Error-free product of two f32: result.x = fl(a*b), a*b == result.x + result.y.
// fma makes the residual exact, matching the host double computed in the TS mirror.
fn two_prod(a : f32, b : f32) -> vec2<f32> {
    let p = a * b;
    let e = fma(a, b, -p);
    return vec2<f32>(p, e);
}

fn df64_add(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
    var s = two_sum(a.x, b.x);
    let t = two_sum(a.y, b.y);
    s.y = s.y + t.x;
    s = quick_two_sum(s.x, s.y);
    s.y = s.y + t.y;
    return quick_two_sum(s.x, s.y);
}

fn df64_sub(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
    return df64_add(a, df64_neg(b));
}

fn df64_mul(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
    var p = two_prod(a.x, b.x);
    p.y = p.y + (a.x * b.y + a.y * b.x);
    return quick_two_sum(p.x, p.y);
}

// df64 * f32 scalar (cheaper than the full df64 * df64).
fn df64_mul_f32(a : vec2<f32>, s : f32) -> vec2<f32> {
    var p = two_prod(a.x, s);
    p.y = p.y + a.y * s;
    return quick_two_sum(p.x, p.y);
}

// Reciprocal 1/a via Newton refinement on an f32 seed.
fn df64_recip(a : vec2<f32>) -> vec2<f32> {
    var x = vec2<f32>(1.0 / a.x, 0.0);
    let two = vec2<f32>(2.0, 0.0);
    for (var i = 0; i < 3; i = i + 1) {
        x = df64_mul(x, df64_sub(two, df64_mul(a, x)));
    }
    return x;
}

fn df64_div(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
    return df64_mul(a, df64_recip(b));
}

// Inverse square root 1/sqrt(a) via Newton refinement on an f32 seed.
fn df64_invsqrt(a : vec2<f32>) -> vec2<f32> {
    var x = vec2<f32>(inverseSqrt(a.x), 0.0);
    let half = df64_mul_f32(a, 0.5);
    let one_and_half = vec2<f32>(1.5, 0.0);
    for (var i = 0; i < 3; i = i + 1) {
        let t = df64_mul(df64_mul(x, x), half);
        x = df64_mul(x, df64_sub(one_and_half, t));
    }
    return x;
}

fn df64_sqrt(a : vec2<f32>) -> vec2<f32> {
    if (a.x <= 0.0) {
        return vec2<f32>(0.0, 0.0);
    }
    return df64_mul(a, df64_invsqrt(a));
}
