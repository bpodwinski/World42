// FSR1 RCAS — Robust Contrast-Adaptive Sharpening (WGSL port)
// Based on AMD FidelityFX Super Resolution 1 (MIT License).
// Reads the EASU-upscaled image and applies local contrast-adaptive sharpening.
// High-contrast areas receive less sharpening to avoid haloing.

varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

// Pixel dimensions of the input texture (full-res EASU output).
uniform inputSize: vec2f;
// Sharpness: 0.0 = maximum sharpening, 2.0 = no sharpening.
uniform rcasSharpness: f32;

fn lum(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn tap(tc: vec2f) -> vec4f {
    return textureSample(textureSampler, textureSamplerSampler, tc / uniforms.inputSize);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // Pixel centre in texel space.
    let px = input.vUV * uniforms.inputSize;

    // 5-tap cross neighbourhood.
    let cC = tap(px);
    let cN = tap(px + vec2f( 0.0, -1.0));
    let cS = tap(px + vec2f( 0.0,  1.0));
    let cW = tap(px + vec2f(-1.0,  0.0));
    let cE = tap(px + vec2f( 1.0,  0.0));

    // Luma of each tap.
    let lC = lum(cC.rgb);
    let lN = lum(cN.rgb);
    let lS = lum(cS.rgb);
    let lW = lum(cW.rgb);
    let lE = lum(cE.rgb);

    // Local min/max luma (used to clamp the output and detect contrast).
    let lMin = min(lC, min(min(lN, lS), min(lW, lE)));
    let lMax = max(lC, max(max(lN, lS), max(lW, lE)));

    // Sharpening weight: inversely proportional to local contrast.
    // High contrast → small weight → less sharpening (avoids haloing).
    // rcasSharpness remapped: 0→peak, 2→zero via exp2(-rcasSharpness).
    let contrast = lMax - lMin + 1e-5;
    let peakWeight = exp2(-uniforms.rcasSharpness);  // strength parameter
    let w = -peakWeight / contrast;                  // negative → sharpening

    // Normalised sharpened colour: center * (1 + 4*|w|) - neighbours * |w|
    // Equivalent to: center - w * laplacian(centre)
    let wNorm = 1.0 + 4.0 * abs(w);
    var color = (cC * wNorm - (cN + cS + cW + cE) * abs(w)) / wNorm;

    // Clamp to local neighbourhood to prevent ringing.
    let cMin = min(cC, min(min(cN, cS), min(cW, cE)));
    let cMax = max(cC, max(max(cN, cS), max(cW, cE)));
    color = clamp(color, cMin, cMax);

    fragmentOutputs.color = vec4f(color.rgb, cC.a);
    return fragmentOutputs;
}
