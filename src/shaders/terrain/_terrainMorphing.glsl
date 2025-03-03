#define NUM_LOD_LEVELS 8

//------------------------------------------------------------------------------
// Uniforms
//------------------------------------------------------------------------------
uniform mat4 world;
uniform float lodLevel;                     // Current LOD level
uniform float lodRangesLUT[NUM_LOD_LEVELS]; // Distance thresholds per LOD

/**
 * @brief Computes the morphing factor for LOD blending based on distance.
 *
 * @param dist Distance between the vertex (in world space) and the camera.
 * @param lodLvl Current LOD level.
 * @return A morph factor clamped between 0.0 and 1.0.
 */
float getMorphValue(float dist, float lodLvl) {
  float low = (lodLvl > 0.0) ? lodRangesLUT[int(lodLvl) - 1] : 0.0;
  float high = lodRangesLUT[int(lodLvl)];
  float delta = high - low;
  float factor = (dist - low) / delta;

  return clamp(factor / 0.45 - 1.0, 0.0, 1.0);
}

/**
 * @brief Computes the displaced vertex position based solely on the heightmap morph factor.
 *
 * This function transforms the original position to world space, calculates the distance
 * to the camera, and then computes a morph factor for LOD blending. It then displaces the
 * original position along the normal using this morph factor and a given amplitude.
 *
 * @param pos Original vertex position (in object space).
 * @param norm Vertex normal.
 * @param amp Amplitude of displacement.
 * @param cameraPos Camera position in world space.
 * @return The displaced vertex position (in object space).
 */
vec3 computeDisplacedPosition(vec3 pos, vec3 norm, float amp, vec3 cameraPos) {
  // Transform the original position into world space.
  vec4 worldPos = world * vec4(pos, 1.0);
  float dist = distance(worldPos.xyz, cameraPos);

  // Compute the morph factor for LOD blending.
  float morphValue = getMorphValue(dist, lodLevel);

  // Displace the original position along the normal, modulated by the morph factor.
  return pos + norm * morphValue * amp;
}
