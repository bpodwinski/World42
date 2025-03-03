/**
 * @brief Computes flexible triplanar mapping for a given texture with an optional non-tiling mode.
 *
 * The function calculates blending weights based on the absolute components of the normalized surface normal,
 * computes UV coordinates for each projection (applying a UV offset), and then samples the texture.
 * If noTile is true, the function uses a non-tiling sampling (textureNoTile) to reduce visible repetition;
 * otherwise, it uses the standard texture2D sampling.
 *
 * @param tex The texture sampler.
 * @param pos World-space position.
 * @param normal World-space normal.
 * @param scale UV scaling factor.
 * @param offset Additional UV offset.
 * @param noTile If true, apply non-tiling sampling.
 * @return The color obtained by blending the three projections.
 */
vec4 triplanar(sampler2D tex, vec3 pos, vec3 normal, float scale, vec2 offset, bool noTile) {
    vec3 blending = abs(normal);
    blending = normalize(max(blending, 0.00001)); // Avoid division by zero
    float b = blending.x + blending.y + blending.z;
    blending /= b;

    // Compute UV coordinates for each projection with additional offset.
    vec2 xUV = pos.yz * scale + offset;
    vec2 yUV = pos.xz * scale + offset;
    vec2 zUV = pos.xy * scale + offset;

    // Sample the texture using either non-tiling mode or standard sampling.
    // Note: The function textureNoTile(tex, uv) must be defined in an include.
    vec4 xProjection = noTile ? textureNoTile(tex, xUV) : texture2D(tex, xUV);
    vec4 yProjection = noTile ? textureNoTile(tex, yUV) : texture2D(tex, yUV);
    vec4 zProjection = noTile ? textureNoTile(tex, zUV) : texture2D(tex, zUV);

    return xProjection * blending.x + yProjection * blending.y + zProjection * blending.z;
}
