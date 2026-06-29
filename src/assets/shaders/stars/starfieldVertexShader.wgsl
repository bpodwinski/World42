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
// applies when transpiling GLSL. The Y-flip is done manually (same as terrain_render_material).

// [ra, dec, mag, bv] per star — positional data used for direction + scintillation seed.
var<storage, read> starData   : array<vec4<f32>>;
// [r, g, b, baseRadius] per star — precomputed once on CPU at load time.
// Replaces bvToLinearRgb() + baseRadius(mag) which previously ran 4× per star per frame.
var<storage, read> starColors : array<vec4<f32>>;

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
    let ra  = star.x;
    let dec = star.y;
    let mag = star.z;

    // Per-star precomputed data: [r, g, b, baseRadius] — computed once on CPU at load time.
    let colorData  = starColors[vertexInputs.instanceIndex];
    let baseRadius = colorData.w;

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
        vertexOutputs.vBaseRadius  = baseRadius;
        vertexOutputs.vPixelRadius = baseRadius;
        return vertexOutputs;
    }

    // NDC center of the star (perspective divide).
    let ndcCenter = clip.xy / clip.w;

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
            // Star is below the local horizon: collapse to degenerate vertex (no fragments).
            vertexOutputs.position    = vec4<f32>(0.0, 0.0, 2.0, 1.0);
            vertexOutputs.vColor      = vec3<f32>(0.0);
            vertexOutputs.vBrightness = 0.0;
            vertexOutputs.vOffset     = vec2<f32>(0.0);
            vertexOutputs.vBaseRadius  = baseRadius;
            vertexOutputs.vPixelRadius = baseRadius;
            return vertexOutputs;
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

    // Apply reddening to the precomputed hue and re-normalise (brightness stays in vBrightness).
    let reddenedHue = colorData.xyz * extRgb;
    let huePeak = max(max(reddenedHue.r, reddenedHue.g), reddenedHue.b);
    vertexOutputs.vColor       = reddenedHue / max(huePeak, 1.0e-5);
    vertexOutputs.vBrightness  = clippedBr;
    vertexOutputs.vOffset      = corner;
    vertexOutputs.vBaseRadius  = baseRadius;
    vertexOutputs.vPixelRadius = pixelRadius;
    return vertexOutputs;
}
