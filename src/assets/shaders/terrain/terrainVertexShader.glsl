#define NUM_LOD_LEVELS 8

/*
 * Planetary Terrain Vertex Shader
 *
 * This shader displaces planetary terrain vertices using procedural logic and LOD morphing,
 * without sampling a heightmap to modify altitude.
 */
precision highp float;

//------------------------------------------------------------------------------
// Attributes
//------------------------------------------------------------------------------
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

//------------------------------------------------------------------------------
// Uniforms
//------------------------------------------------------------------------------
uniform mat4 worldViewProjection;
uniform float time;
uniform float amplitude;
uniform float frequency;
uniform float mesh_dim;      // Subdivision count (used for morphing)
uniform float lodMaxLevel;   // Maximum LOD level
uniform vec3 cameraPosition;
uniform vec3 uPlanetCenter;  // Planet global center (planet-local origin)
uniform vec3 uPatchCenter;   // Patch center (computed on CPU)

//------------------------------------------------------------------------------
// Varyings (to fragment shader)
//------------------------------------------------------------------------------
varying vec2 vUV;
varying vec3 vRadial;
varying vec3 vPosition;
varying vec3 vNormal;

void main(void) {
  // Displace the vertex along its normal (simple radial displacement)
  vec3 displacedPosition = position + normal * amplitude;

  // Generate UVs relative to the patch center (stable for patch-local texturing/debug)
  vec3 diff = normalize(displacedPosition - uPatchCenter);
  float longitude = atan(diff.z, diff.x);
  float latitude = asin(diff.y);

  // Convert spherical coordinates to [0..1] UV range
  float uCoord = (longitude + 3.14159) / (2.0 * 3.14159);
  float vCoord = (latitude + 1.5708) / 3.14159;
  vUV = vec2(uCoord, vCoord);

  // Pass through displaced position (planet-local) to the fragment shader
  vPosition = displacedPosition;

  // Pass the smoothed normal (interpolated across triangles)
  vNormal = normal;

  // Radial direction from planet center (useful for lighting/blending logic)
  vRadial = normalize(displacedPosition - uPlanetCenter);

  // Final clip-space position
  gl_Position = worldViewProjection * vec4(displacedPosition, 1.0);
}
