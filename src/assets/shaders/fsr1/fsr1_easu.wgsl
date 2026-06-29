// FSR1 EASU — Edge-Adaptive Spatial Upsampling (WGSL port)
// Based on AMD FidelityFX Super Resolution 1 (MIT License).
// Reads the scene rendered at renderScale resolution and writes the
// upscaled result at display resolution using a gradient-adaptive 4-tap
// filter blended between Catmull-Rom (smooth areas) and bilinear (edges).

varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

// Pixel dimensions of the LOW-RESOLUTION input texture.
uniform inputSize: vec2f;
// Pixel dimensions of the FULL-RESOLUTION output texture.
uniform outputSize: vec2f;

fn lum(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn tap(tc: vec2f) -> vec4f {
    return textureSample(textureSampler, textureSamplerSampler, tc / uniforms.inputSize);
}

// Catmull-Rom 1D weight at distance |d| (d in [-2,2], zero outside).
fn crW(d: f32) -> f32 {
    let ad = abs(d);
    if (ad >= 2.0) { return 0.0; }
    if (ad >= 1.0) { return ad * ad * (-0.5 * ad + 2.5) - 4.0 * ad + 2.0; }
    return ad * ad * (1.5 * ad - 2.5) + 1.0;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // Map from output UV to pixel position in the low-res input texture.
    // Half-pixel correction: pixel centres sit at integer + 0.5.
    let inPos = input.vUV * uniforms.inputSize - 0.5;
    let pp = floor(inPos);       // top-left texel of the 2x2 kernel
    let f  = inPos - pp;         // sub-texel fractional offset [0,1)

    // 12-tap H-shaped neighbourhood for gradient estimation.
    //        [0,-1] [1,-1]
    // [-1,0] [0, 0] [1, 0] [2,0]
    // [-1,1] [0, 1] [1, 1] [2,1]
    //        [0, 2] [1, 2]
    let bL  = lum(tap(pp + vec2f( 0.0, -1.0)).rgb);
    let cL  = lum(tap(pp + vec2f( 1.0, -1.0)).rgb);
    let eL  = lum(tap(pp + vec2f(-1.0,  0.0)).rgb);
    let fLL = lum(tap(pp + vec2f( 0.0,  0.0)).rgb);
    let gL  = lum(tap(pp + vec2f( 1.0,  0.0)).rgb);
    let hL  = lum(tap(pp + vec2f( 2.0,  0.0)).rgb);
    let iLL = lum(tap(pp + vec2f(-1.0,  1.0)).rgb);
    let jL  = lum(tap(pp + vec2f( 0.0,  1.0)).rgb);
    let kL  = lum(tap(pp + vec2f( 1.0,  1.0)).rgb);
    let lL  = lum(tap(pp + vec2f( 2.0,  1.0)).rgb);
    let nL  = lum(tap(pp + vec2f( 0.0,  2.0)).rgb);
    let oL  = lum(tap(pp + vec2f( 1.0,  2.0)).rgb);

    // 4 core colour samples.
    let c00 = tap(pp + vec2f(0.0, 0.0));
    let c10 = tap(pp + vec2f(1.0, 0.0));
    let c01 = tap(pp + vec2f(0.0, 1.0));
    let c11 = tap(pp + vec2f(1.0, 1.0));

    // Gradient magnitude: how much change in horizontal vs vertical direction.
    // High gH → horizontal edge → filter along Y should be tight.
    // High gV → vertical edge   → filter along X should be tight.
    let gH = abs((bL + cL) - (nL + oL)) + abs((fLL + gL) - (jL + kL));
    let gV = abs((eL + iLL) - (hL + lL)) + abs((fLL + jL) - (gL + kL));
    let gSum = gH + gV + 1e-5;

    // edgeBlend: 1.0 near a strong edge, 0.0 in smooth areas.
    // Near edges we fall back to bilinear to suppress ringing.
    let edgeBlend = clamp((max(gH, gV) - 0.1 * gSum) / gSum * 4.0, 0.0, 1.0);

    // Separable weights: Catmull-Rom in smooth areas, bilinear on edges.
    var wX0 = crW(f.x);
    var wX1 = crW(f.x - 1.0);
    var wY0 = crW(f.y);
    var wY1 = crW(f.y - 1.0);

    // Normalize Catmull-Rom weights to [0,1] pair (4-tap CR can go negative at taps -1 and 2
    // which we don't have here, so restrict to the 2-tap range).
    let crSumX = abs(wX0) + abs(wX1);
    let crSumY = abs(wY0) + abs(wY1);
    wX0 = wX0 / crSumX;
    wX1 = wX1 / crSumX;
    wY0 = wY0 / crSumY;
    wY1 = wY1 / crSumY;

    // Blend toward bilinear on edges.
    let bX0 = 1.0 - f.x;
    let bX1 = f.x;
    let bY0 = 1.0 - f.y;
    let bY1 = f.y;
    let wx0 = mix(wX0, bX0, edgeBlend);
    let wx1 = mix(wX1, bX1, edgeBlend);
    let wy0 = mix(wY0, bY0, edgeBlend);
    let wy1 = mix(wY1, bY1, edgeBlend);

    // Weighted sum of the 4 core taps.
    var color = c00 * wx0 * wy0
              + c10 * wx1 * wy0
              + c01 * wx0 * wy1
              + c11 * wx1 * wy1;

    // Anti-ringing clamp: restrict output to the local min/max of the 4 core taps.
    let cMin = min(min(c00, c10), min(c01, c11));
    let cMax = max(max(c00, c10), max(c01, c11));
    color = clamp(color, cMin, cMax);

    fragmentOutputs.color = color;
    return fragmentOutputs;
}
