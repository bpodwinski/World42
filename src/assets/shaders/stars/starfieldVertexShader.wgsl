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

uniform viewProjection : mat4x4<f32>;
uniform viewport       : vec2<f32>;   // canvas size in pixels (width, height)

varying vColor      : vec3<f32>;
varying vBrightness : f32;
varying vOffset     : vec2<f32>;  // corner offset in [-0.5, +0.5] for PSF in fragment

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

// B-V color index → linear RGB (approximate stellar spectral color).
// Piece-wise polynomial fit to standard stellar color tables.
// Input: B-V in the typical range [-0.4, 2.0] (blue O-type to red M-type).
// Output: linear RGB (input values are display-gamma-encoded; pow(2.2) linearizes).
fn bvToLinearRgb(bv : f32) -> vec3<f32> {
    let t = clamp(bv, -0.4, 2.0);

    var r : f32;
    if (t < 0.0)      { r = 0.61 + 0.11 * t + 0.1 * t * t; }
    else if (t < 0.4) { r = 0.83 + 0.17 * t; }
    else               { r = 1.0; }

    var g : f32;
    if (t < 0.0)      { g = 0.70 + 0.07 * t; }
    else if (t < 0.6) { g = 0.87 - 0.1 * t + 0.02 * t * t; }
    else if (t < 1.6) { g = 1.0 - 0.5 * (t - 0.6); }
    else               { g = 0.5; }

    var b : f32;
    if (t < 0.4)      { b = 1.0; }
    else if (t < 1.5) { b = 1.0 - 0.5 * (t - 0.4); }
    else               { b = 0.0; }

    // Decode sRGB display values to linear (approximate γ = 2.2).
    return pow(clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(2.2));
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

    // Billboard pixel radius from apparent magnitude.
    // Flux relative to mag 6 (bright edge of the naked-eye limit).
    // pow(flux, 0.25) compresses the range so very bright stars don't dwarf faint ones.
    let flux = pow(10.0, -0.4 * (mag - 6.0));
    let pixelRadius = clamp(1.0 + 2.0 * pow(flux, 0.25), 1.0, 14.0);

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

    // Linear HDR brightness from apparent magnitude.
    // Vega (mag 0) → ~0.8 linear units (pre-bloom). Faint limit (mag 8) → ~0.0005.
    let brightness = 0.8 * pow(10.0, -0.4 * mag);

    vertexOutputs.vColor      = bvToLinearRgb(bv);
    vertexOutputs.vBrightness = brightness;
    vertexOutputs.vOffset     = corner;  // passed to fragment for Gaussian PSF distance
    return vertexOutputs;
}
