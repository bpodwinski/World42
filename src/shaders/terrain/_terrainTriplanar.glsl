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
vec4 triplanar(vec3 pos, vec3 normal, float scale, vec2 offset, bool noTile) {
    vec3 blending = abs(normal);
    blending = normalize(max(blending, 0.00001)); // Eviter la division par zéro
    float b = blending.x + blending.y + blending.z;
    blending /= b;

    // Calculer les coordonnées UV pour chaque projection
    vec2 xUV = pos.yz * scale + offset;
    vec2 yUV = pos.xz * scale + offset;
    vec2 zUV = pos.xy * scale + offset;

    // Échantillonner avec le mode non tiling ou standard en utilisant le sampler global
    vec4 xProjection = noTile ? textureNoTile(xUV) : texture(detailTexture, xUV);
    vec4 yProjection = noTile ? textureNoTile(yUV) : texture(detailTexture, yUV);
    vec4 zProjection = noTile ? textureNoTile(zUV) : texture(detailTexture, zUV);

    return xProjection * blending.x + yProjection * blending.y + zProjection * blending.z;
}

/**
 * @brief Computes an equirectangular projection UV and samples the texture.
 *
 * The function converts the world-space position relative to the sphere's center into spherical coordinates,
 * then maps those coordinates to UV space using an equirectangular projection. The resulting UVs are scaled
 * and offset. If noTile is true, it uses non-tiling sampling (textureNoTile), otherwise standard texture2D sampling.
 *
 * @param tex The texture sampler.
 * @param pos World-space position.
 * @param center The center of the sphere.
 * @param scale UV scaling factor.
 * @param offset Additional UV offset.
 * @param noTile If true, apply non-tiling sampling.
 * @return The color obtained from the texture.
 */
vec4 equirectangularProjection(vec3 pos, vec3 center, float scale, vec2 offset) {
    // Calcul de la direction normalisée entre le centre et la position
    vec3 dir = normalize(pos - center);
    float longitude = atan(dir.z, dir.x);
    float latitude = asin(dir.y);
    float u = (longitude + 3.14159) / (2.0 * 3.14159);
    float v = (latitude + 1.5708) / 3.14159;
    vec2 uv = vec2(u, v);

    // Appliquer l'échelle et le décalage
    uv = uv * scale + offset;

    // Échantillonner le sampler global avec texture() au lieu de texture2D()
    return texture(diffuseTexture, uv);
}
