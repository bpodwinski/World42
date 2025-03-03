/**
 * @brief Hash function to generate a pseudo-random vec4 from an ivec2 input.
 *
 * Converts the integer vector into a float vector, computes a dot product with constant
 * coefficients, and then uses sin() and fract() to produce a pseudo-random vec4.
 *
 * @param p The input ivec2.
 * @return A pseudo-random vec4.
 */
vec4 hash4(ivec2 p) {
    vec2 pf = vec2(p);
    float n = dot(pf, vec2(127.1, 311.7));
    return fract(vec4(sin(n + 0.0) * 43758.5453, sin(n + 1.0) * 43758.5453, sin(n + 2.0) * 43758.5453, sin(n + 3.0) * 43758.5453));
}

/**
 * @brief Computes a non-tiling texture sample using per-tile random offsets and blending.
 *
 * This function breaks the visible repetition of a texture by generating a per-tile
 * random transform using a hash function. It computes modified UV coordinates and their
 * derivatives for each of four neighboring tiles, then blends the results smoothly.
 *
 * @param samp The texture sampler.
 * @param uv The UV coordinates.
 * @return The blended texture color.
 */
vec4 textureNoTile(sampler2D samp, in vec2 uv) {
    ivec2 iuv = ivec2(floor(uv));
    vec2 fuv = fract(uv);

    // Generate per-tile transform using the hash function.
    vec4 ofa = hash4(iuv + ivec2(0, 0));
    vec4 ofb = hash4(iuv + ivec2(1, 0));
    vec4 ofc = hash4(iuv + ivec2(0, 1));
    vec4 ofd = hash4(iuv + ivec2(1, 1));

    vec2 ddx = dFdx(uv);
    vec2 ddy = dFdy(uv);

    // Transform per-tile UVs: mirror the UVs based on the hash result.
    ofa.zw = sign(ofa.zw - 0.5);
    ofb.zw = sign(ofb.zw - 0.5);
    ofc.zw = sign(ofc.zw - 0.5);
    ofd.zw = sign(ofd.zw - 0.5);

    // Compute modified UVs and corresponding derivatives for proper mipmapping.
    vec2 uva = uv * ofa.zw + ofa.xy;
    vec2 ddxa = ddx * ofa.zw;
    vec2 ddya = ddy * ofa.zw;

    vec2 uvb = uv * ofb.zw + ofb.xy;
    vec2 ddxb = ddx * ofb.zw;
    vec2 ddyb = ddy * ofb.zw;

    vec2 uvc = uv * ofc.zw + ofc.xy;
    vec2 ddxc = ddx * ofc.zw;
    vec2 ddyc = ddy * ofc.zw;

    vec2 uvd = uv * ofd.zw + ofd.xy;
    vec2 ddxd = ddx * ofd.zw;
    vec2 ddyd = ddy * ofd.zw;

    // Compute blend weights using smoothstep.
    vec2 b = smoothstep(0.25, 0.75, fuv);

    return mix(mix(textureGrad(samp, uva, ddxa, ddya), textureGrad(samp, uvb, ddxb, ddyb), b.x), mix(textureGrad(samp, uvc, ddxc, ddyc), textureGrad(samp, uvd, ddxd, ddyd), b.x), b.y);
}
