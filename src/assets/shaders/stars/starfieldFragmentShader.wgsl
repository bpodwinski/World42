// Starfield billboard fragment shader — bounded human-eye PSF.
//
// Implements a two-tier approximation of the photopic PSF by Spencer et al. (1995),
// as used in CelestiaStarRenderer (Askaniy/CelestiaStarRenderer on GitHub):
//
//   Tier 1 — Point core  [dist ≤ baseRadius]:
//     Linear cone: max(0, 1 − dist/R) × min(br, 1)
//     Faint stars never leave this region.
//
//   Tier 2 — Eye PSF bloom  [all dist, additive, only when br > 1]:
//     ((br^0.4 / max(dist, 0.1) − a) × b)^2.5,  clamped to [0, br]
//     where a = OPTIMIZATION / baseRadius, b = 1 / (π / baseRadius − a).
//     The bloom naturally falls to 0 at dist = bloomRadius = br^0.4 / a,
//     which is exactly the billboard edge for bright stars.
//
// Rendering setup:
//   ALPHA_ADD blending — star contributions accumulate on the cleared black background.
//   No depth write; NDC z = 0.9999 passes for sky, fails for terrain.
//   ACES tone mapping (later pass) compresses the HDR bloom values.
//
// Brightness reference: mag 1.5 → clippedBr = 1.0 (bloom onset, ~25 brightest stars).
// Vega (mag 0) → clippedBr ≈ 2.4; Sirius (mag −1.46) → clippedBr ≈ 4.3 (soft-capped at 6).

varying vColor       : vec3<f32>;
varying vBrightness  : f32;
varying vOffset      : vec2<f32>;
varying vBaseRadius  : f32;
varying vPixelRadius : f32;

const OPTIMIZATION : f32 = 0.1;
const PI           : f32 = 3.14159265;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
    let d = length(fragmentInputs.vOffset);  // [0, 0.5] normalized billboard distance

    // Discard outside the circular billboard.
    if (d >= 0.5) {
        discard;
    }

    let dist_px  = 2.0 * fragmentInputs.vPixelRadius * d;  // pixel distance from star center
    let base_px  = fragmentInputs.vBaseRadius;
    let br       = fragmentInputs.vBrightness;

    // PSF coefficients (CelestiaStarRenderer / Spencer 1995 approximation).
    let a = OPTIMIZATION / base_px;
    let b = 1.0 / (PI / base_px - a);

    // Tier 1 — linear cone core (all stars, capped at 1.0 for faint stars).
    let core = max(0.0, 1.0 - dist_px / base_px) * min(br, 1.0);

    // Tier 2 — power-law bloom (additive, only computed for bright stars).
    var bloom = 0.0;
    if (br > 1.0) {
        let raw = (pow(br, 0.4) / max(dist_px, 0.1) - a) * b;
        if (raw > 0.0) {
            bloom = clamp(pow(raw, 2.5), 0.0, br);
        }
    }

    let value = core + bloom;

    // Discard near-zero pixels to avoid ALPHA_ADD accumulating invisible overdraw.
    if (value < 0.001) {
        discard;
    }

    fragmentOutputs.color = vec4<f32>(fragmentInputs.vColor * value, 1.0);
    return fragmentOutputs;
}
