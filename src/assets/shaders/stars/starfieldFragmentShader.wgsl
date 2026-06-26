// Starfield billboard fragment shader (BJS WGSL flavor).
//
// Applies a Gaussian PSF (Point Spread Function) approximating the human eye's
// response to a point light source. The billboards are rendered with ALPHA_ADD
// blending so star contributions accumulate on the black cleared background;
// tone-mapping is applied later by the image-processing task (ACES).
//
// The PSF is a simple isotropic Gaussian. A bounded human-eye PSF with diffraction
// spikes and chromatic fringes is planned for Sprint 2 (issue #16).

varying vColor      : vec3<f32>;
varying vBrightness : f32;
varying vOffset     : vec2<f32>;  // corner offset in [-0.5, +0.5]

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
    let d = length(fragmentInputs.vOffset);

    // Discard corners to produce a circular billboard.
    if (d > 0.5) {
        discard;
    }

    // Isotropic Gaussian PSF.
    // sigma = 0.18 concentrates most energy in the core (~1/3 of the billboard radius)
    // while leaving a soft halo that bloom will amplify for bright stars.
    let sigma = 0.18;
    let g = exp(-d * d / (2.0 * sigma * sigma));

    // Linear HDR output: color × magnitude-brightness × Gaussian falloff.
    // ALPHA_ADD blending: output = src + dest (stars accumulate on the black background).
    fragmentOutputs.color = vec4<f32>(fragmentInputs.vColor * fragmentInputs.vBrightness * g, 1.0);
    return fragmentOutputs;
}
