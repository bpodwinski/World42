/*
 * Planetary Terrain Vertex Shader
 *
 * This shader computes the vertex positions for a planetary terrain by displacing
 * vertices based on a height map and noise-based morphing. It also generates
 * triplanar UV coordinates for texturing and passes necessary varyings (UVs,
 * normals, position, and height) to the fragment shader.
 */
//#define NUM_LOD_LEVELS 16
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
//uniform mat4 world;
uniform float time;
uniform float amplitude;
uniform float frequency;
uniform float mesh_dim;                     // Number of subdivisions (optional for morphing on XZ plane)
uniform float lodMaxLevel;                  // Maximum LOD level
//uniform float lodLevel;                     // Current LOD level
//uniform float lodRangesLUT[NUM_LOD_LEVELS]; // Distance thresholds per LOD
uniform vec3 cameraPosition;
uniform vec3 uPlanetCenter;                 // Constant planet center in world space

uniform sampler2D heightMap;
uniform float heightFactor;                 // Height amplification factor for displacement
uniform float textureScale;                 // Parameter for triplanar UV generation

//------------------------------------------------------------------------------
// Varyings for Fragment Shader
//------------------------------------------------------------------------------
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vPosition;
varying float vHeight;

//------------------------------------------------------------------------------
// Includes
//------------------------------------------------------------------------------
#include<noise>
#include<morphing>

//------------------------------------------------------------------------------
// Vertex Triplanar Sampling Function (without derivatives)
// Computes approximate UV coordinates for each axis and blends them based on the absolute value of the normal.
//------------------------------------------------------------------------------
vec4 vertexTriplanar(sampler2D tex, vec3 pos, vec3 norm, float scale) {
  vec3 blending = abs(norm);
  blending = normalize(max(blending, 0.00001)); // Avoid division by zero
  float total = blending.x + blending.y + blending.z;
  blending /= total;

  // Compute UVs for each axis
  vec2 uvX = pos.yz * scale;
  vec2 uvY = pos.xz * scale;
  vec2 uvZ = pos.xy * scale;

  // Sample the texture on each axis
  vec4 sampleX = texture2D(tex, uvX);
  vec4 sampleY = texture2D(tex, uvY);
  vec4 sampleZ = texture2D(tex, uvZ);

  // Weighted interpolation of the samples
  return sampleX * blending.x + sampleY * blending.y + sampleZ * blending.z;
}

//------------------------------------------------------------------------------
// Main Function
//------------------------------------------------------------------------------
void main(void) {
  // Compute the displaced position using noise and morphing functions
  vec3 displacedPosition = computeDisplacedPosition(position, normal, amplitude, cameraPosition);

  // Sample the height map using a triplanar approach
  vec4 heightSample = vertexTriplanar(heightMap, position, normalize(normal), textureScale);
  float height = heightSample.r;
  vHeight = height;

  // Apply displacement along the vertex normal based on the height value and heightFactor
  displacedPosition += normalize(normal) * height * heightFactor;

  //vec4 worldDisplaced = world * vec4(displacedPosition, 1.0);
  vPosition = displacedPosition;
  vNormal = normalize(mat3(world) * normal);
  vUV = uv;
  gl_Position = worldViewProjection * vec4(displacedPosition, 1.0);
}
