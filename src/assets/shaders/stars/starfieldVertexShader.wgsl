// Starfield billboard vertex shader (BJS WGSL flavor).
//
// One GPU instance per catalog star; template mesh = 4-vertex quad (indices 0,1,2,0,2,3).
// Star data layout (StorageBuffer, array<vec4<f32>>): [ra, dec, mag, bv] per entry.
//
// The vertex shader converts RA/Dec to a world-space direction, projects to clip space,
// and offsets the quad corners in NDC to produce a pixel-sized billboard. Billboard size
// scales log-linearly with apparent magnitude. Color is derived from the B-V index.
//
// Coordinate-space note: stars are at effectively infinite distance. The engine uses a
// floating origin so the camera is always at render-space (0,0,0). The viewProjection
// matrix encodes only camera rotation (no translation offset at stellar scales), which is
// exactly what we need: stars stay fixed in the world as the camera rotates.
//
// Depth: billboards are placed at NDC z = 0.9999 (just inside the far plane). The depth
// buffer is cleared to 1.0, so stars pass the LESS depth test for sky pixels. Terrain
// writes log-encoded depth values < 0.9999, so stars fail the test for terrain pixels.
// No depth write → terrain depth buffer is untouched.
//
// BJS WGSL note: BJS ShaderMaterial does NOT auto-inject the WebGPU NDC-Y flip that it
// applies when transpiling GLSL. The Y-flip is done manually (same as ocbt_render_material).

var<storage, read> starData : array<vec4<f32>>;

uniform viewProjection   : mat4x4<f32>;
uniform viewport         : vec2<f32>;    // canvas size in pixels (width, height)
uniform time             : f32;          // seconds (performance.now() / 1000)
uniform worldUp          : vec3<f32>;    // surface normal at camera (planet centre → camera)
uniform atmosphereFactor : f32;          // 0 = space / airless body, 1 = at planet surface

varying vColor       : vec3<f32>;
varying vBrightness  : f32;   // soft-clipped irradiance (mag 1.5 → 1.0; >1 triggers bloom PSF)
varying vOffset      : vec2<f32>;  // corner offset in [-0.5, +0.5]
varying vBaseRadius  : f32;   // point_radius in pixels — PSF core boundary
varying vPixelRadius : f32;   // total billboard radius in pixels (≥ vBaseRadius)

attribute position : vec3<f32>;   // dummy — positions are computed from star data

// Quad corner offsets for indices [0,1,2, 0,2,3].
fn cornerOffset(vi : u32) -> vec2<f32> {
    switch (vi) {
        case 0u: { return vec2<f32>(-0.5, -0.5); }
        case 1u: { return vec2<f32>( 0.5, -0.5); }
        case 2u: { return vec2<f32>( 0.5,  0.5); }
        default: { return vec2<f32>(-0.5,  0.5); }  // case 3
    }
}

// B-V color index → linear sRGB via physical blackbody pipeline.
//
// Pipeline:
//   1. B-V → T_eff  (Ballesteros 2012, A&A 536, A9)
//   2. T_eff → CIE 1931 xy chromaticity  (Kang et al. 2002, Planckian locus)
//   3. xy → XYZ (Y = 1, chromaticity only)
//   4. XYZ → linear sRGB  (D65, IEC 61966-2-1)
//   5. Normalize peak channel to 1 — hue only; brightness comes from vBrightness.
//
// Valid B-V range: [-0.4, 2.0]  (hot blue O-type → cool red M-type).
// Corresponding T_eff range: ~3 200 K – ~21 700 K, within Kang's [1667, 25000] K domain.
fn bvToLinearRgb(bv : f32) -> vec3<f32> {
    // Step 1 — B-V → effective temperature.
    let t = clamp(bv, -0.4, 2.0);
    let T = 4600.0 * (1.0 / (0.92 * t + 1.7) + 1.0 / (0.92 * t + 0.62));

    // Step 2 — T_eff → CIE 1931 xy (Planckian locus, Kang et al. 2002).
    let T2 = T * T;
    let T3 = T2 * T;
    var x : f32;
    if (T < 4000.0) {
        x = -2.661239e8 / T3 - 2.343580e5 / T2 + 8.776956e2 / T + 0.179910;
    } else {
        x = -3.025847e9 / T3 + 2.107038e6 / T2 + 2.226347e2 / T + 0.240390;
    }
    var y : f32;
    if (T < 2222.0) {
        y = -1.1063814 * x*x*x - 1.34811020 * x*x + 2.18555832 * x - 0.20219683;
    } else if (T < 4000.0) {
        y = -0.9549476 * x*x*x - 1.37418593 * x*x + 2.09137015 * x - 0.16748867;
    } else {
        y =  3.0817580 * x*x*x - 5.87338670 * x*x + 3.75112997 * x - 0.37001483;
    }

    // Step 3 — xy → XYZ  (Y = 1).
    let X = x / y;
    let Z = (1.0 - x - y) / y;

    // Step 4 — XYZ → linear sRGB  (D65, IEC 61966-2-1).
    let r =  3.2404542 * X - 1.5371385       - 0.4985314 * Z;
    let g = -0.9692660 * X + 1.8760108       + 0.0415560 * Z;
    let b =  0.0556434 * X - 0.2040259       + 1.0572252 * Z;
    let rgb = max(vec3<f32>(r, g, b), vec3<f32>(0.0));

    // Step 5 — normalize to hue only (brightness is handled by vBrightness).
    let peak = max(max(rgb.r, rgb.g), rgb.b);
    return rgb / max(peak, 1.0e-5);
}

// Atmospheric scintillation noise for a given star instance.
// Returns a value in roughly [-1, 1] built from four sine waves at frequencies
// matching real atmospheric scintillation (~2–25 Hz). The golden-ratio seed spreads
// phase uniformly across instances so no two stars blink in sync.
fn scintillate(instanceIdx : u32, t : f32) -> f32 {
    let s = f32(instanceIdx) * 0.6180339887;
    return  0.50 * sin(t *  2.3 + s)
          + 0.30 * sin(t *  7.1 + s * 1.6180)
          + 0.15 * sin(t * 15.3 + s * 2.7183)
          + 0.05 * sin(t * 24.7 + s * 3.1416);
}

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
    let star = starData[vertexInputs.instanceIndex];
    let ra   = star.x;
    let dec  = star.y;
    let mag  = star.z;
    let bv   = star.w;

    // RA/Dec (equatorial J2000) → unit direction vector.
    let cosDec = cos(dec);
    let dir = vec3<f32>(cosDec * cos(ra), sin(dec), cosDec * sin(ra));

    // Project to clip space via a far point along the direction.
    // Using 1e6 sim-units avoids precision issues while staying well within maxZ (1e9).
    let clip = uniforms.viewProjection * vec4<f32>(dir * 1.0e6, 1.0);

    // Star behind the camera (clip.w ≤ 0): collapse to a degenerate triangle outside NDC.
    if (clip.w <= 0.0) {
        vertexOutputs.position    = vec4<f32>(0.0, 0.0, 2.0, 1.0);
        vertexOutputs.vColor      = vec3<f32>(0.0);
        vertexOutputs.vBrightness = 0.0;
        vertexOutputs.vOffset     = vec2<f32>(0.0);
        return vertexOutputs;
    }

    // NDC center of the star (perspective divide).
    let ndcCenter = clip.xy / clip.w;

    // Apparent flux and base point radius.
    // Radius scales as flux^0.31: mag 8 → ~0.7 px, mag 6 → ~1.0 px, mag 0 → ~7.0 px.
    // Faint stars stay sub-pixel to avoid ALPHA_ADD overdraw dominating the frame.
    let flux = pow(10.0, -0.4 * mag);
    let baseRadius = clamp(7.0 * pow(flux, 0.31), 0.6, 12.0);

    // Irradiance-scaled brightness: mag 1.5 → 1.0 (bloom onset at the ~25 brightest stars).
    let brightness = pow(10.0, -0.4 * (mag - 1.5));

    // Soft-clip: asymptotic cap so bloom radius stays bounded for Sirius/Canopus.
    // lim(br → ∞) → MAX_IRRADIANCE = 6.0. Leaves faint stars (br << 6) nearly untouched.
    let MAX_IRRADIANCE = 6.0;
    var clippedBr = MAX_IRRADIANCE * brightness / (brightness + MAX_IRRADIANCE);

    // Atmospheric scintillation + extinction (both disabled in space / airless bodies).
    // Per-channel transmission (R, G, B) — default = 1 (no extinction).
    var extRgb = vec3<f32>(1.0, 1.0, 1.0);
    if (uniforms.atmosphereFactor > 0.001) {
        let sinElev = dot(dir, uniforms.worldUp);

        if (sinElev <= 0.0) {
            // Star is below the local horizon: occluded by the planet body.
            clippedBr = 0.0;
        } else {
            let airmass = 1.0 / max(sinElev, 0.05);  // geometric airmass, capped at ~20

            // Scintillation: band-limited brightness turbulence, amplitude ∝ airmass.
            let amplitude = clamp(uniforms.atmosphereFactor * airmass * 0.08, 0.0, 0.4);
            let noise = scintillate(vertexInputs.instanceIndex, uniforms.time);
            clippedBr = clippedBr * max(0.05, 1.0 + amplitude * noise);

            // Atmospheric extinction — Bouguer–Lambert law, per spectral channel.
            // Standard sea-level zenith extinction coefficients (mag per airmass):
            //   R ≈ 0.20  (mostly aerosol)
            //   V ≈ 0.30  (V-band, used as brightness reference)
            //   B ≈ 0.45  (Rayleigh-dominated → most reddening)
            // Factor 0.921 = 0.4 * ln(10) converts magnitudes to flux via Pogson's law.
            let ext = uniforms.atmosphereFactor * airmass;
            let tR = exp(-0.921 * 0.20 * ext);
            let tG = exp(-0.921 * 0.30 * ext);  // V-band transmission
            let tB = exp(-0.921 * 0.45 * ext);
            // Overall brightness follows V-band; reddening is the per-channel ratio vs. green.
            clippedBr = clippedBr * tG;
            extRgb = vec3<f32>(tR / tG, 1.0, tB / tG);
        }
    }

    // Billboard radius: for bright stars, extend to the eye PSF bloom boundary so the
    // fragment shader can evaluate the full halo. bloomR = clippedBr^0.4 / (OPT / baseR).
    let OPTIMIZATION = 0.1;
    var pixelRadius = baseRadius;
    if (clippedBr > 1.0) {
        let bloomR = pow(clippedBr, 0.4) * baseRadius / OPTIMIZATION;
        pixelRadius = min(bloomR, 60.0);
    }
    pixelRadius = max(pixelRadius, baseRadius);

    // NDC extent: convert pixel radius to NDC half-extent (NDC spans 2 units = viewport width).
    let ndcExtent = pixelRadius * 2.0 / uniforms.viewport;
    let corner = cornerOffset(vertexInputs.vertexIndex);

    // Place at the far plane boundary: NDC z = 0.9999 passes the LESS depth test against
    // the cleared depth (1.0) and fails against terrain log-depth values (< 0.9999).
    var pos = vec4<f32>(ndcCenter + corner * ndcExtent, 0.9999, 1.0);

    // BJS WGSL ShaderMaterial: manually flip Y for the WebGPU NDC convention.
    // BJS auto-injects this flip when transpiling GLSL, but not for hand-written WGSL.
    pos.y = -pos.y;
    vertexOutputs.position = pos;

    // Apply reddening to the physical hue and re-normalise (brightness stays in vBrightness).
    let baseHue = bvToLinearRgb(bv);
    let reddenedHue = baseHue * extRgb;
    let huePeak = max(max(reddenedHue.r, reddenedHue.g), reddenedHue.b);
    vertexOutputs.vColor       = reddenedHue / max(huePeak, 1.0e-5);
    vertexOutputs.vBrightness  = clippedBr;
    vertexOutputs.vOffset      = corner;
    vertexOutputs.vBaseRadius  = baseRadius;
    vertexOutputs.vPixelRadius = pixelRadius;
    return vertexOutputs;
}
