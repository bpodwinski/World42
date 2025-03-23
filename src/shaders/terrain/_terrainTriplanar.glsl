/**
 * @brief Computes flexible triplanar mapping for a given texture.
 *
 * The function calculates blending weights based on the absolute components of the normalized surface normal,
 * computes UV coordinates for each projection (applying a UV offset), and then samples the texture.
 * Instead of using a detail texture, it samples the diffuseTexture using standard texture() calls.
 *
 * @param pos World-space position.
 * @param normal World-space normal.
 * @param scale UV scaling factor.
 * @param offset Additional UV offset.
 * @return The color obtained by blending the three projections.
 */
vec4 triplanar(vec3 pos, vec3 normal, float scale, vec2 offset) {
    vec3 blending = abs(normal);
    blending = normalize(max(blending, 0.00001)); // Avoid division by zero
    float b = blending.x + blending.y + blending.z;
    blending /= b;

    // Compute UV coordinates for each projection.
    vec2 xUV = pos.yz * scale + offset;
    vec2 yUV = pos.xz * scale + offset;
    vec2 zUV = pos.xy * scale + offset;

    // Sample the diffuseTexture using standard sampling.
    vec4 xProjection = texture(diffuseTexture, xUV);
    vec4 yProjection = texture(diffuseTexture, yUV);
    vec4 zProjection = texture(diffuseTexture, zUV);

    return xProjection * blending.x + yProjection * blending.y + zProjection * blending.z;
}

/**
 * @brief Computes an equirectangular projection UV and samples the texture.
 *
 * The function converts the world-space position relative to the sphere's center into spherical coordinates,
 * then maps those coordinates to UV space using an equirectangular projection. The resulting UVs are scaled
 * and offset, and the diffuse texture is sampled using texture().
 *
 * @param pos World-space position.
 * @param center The center of the sphere.
 * @param scale UV scaling factor.
 * @param offset Additional UV offset.
 * @return The color obtained from the texture.
 */
vec4 equirectangularProjection(vec3 pos, vec3 center, float scale, vec2 offset) {
    // Compute the normalized direction from the center to the position.
    vec3 dir = normalize(pos - center);
    float longitude = atan(dir.z, dir.x);
    float latitude = asin(dir.y);
    float u = (longitude + 3.14159) / (2.0 * 3.14159);
    float v = (latitude + 1.5708) / 3.14159;
    vec2 uv = vec2(u, v);

    // Apply scale and offset.
    uv = uv * scale + offset;

    // Sample the diffuse texture using standard sampling.
    return texture(diffuseTexture, uv);
}
