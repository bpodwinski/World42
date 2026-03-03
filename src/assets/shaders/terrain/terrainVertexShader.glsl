/*
 * Planetary Terrain Vertex Shader (planet-local shading)
 * Outputs vWorldPos in render-space for shadow projection.
 */
precision highp float;

//------------------------------------------------------------------------------
// Attributes
//------------------------------------------------------------------------------
attribute vec3 position;
attribute vec3 normal;
attribute vec3 morphDelta;
attribute vec2 uv;

//------------------------------------------------------------------------------
// Uniforms
//------------------------------------------------------------------------------
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vWorldPosRender;
uniform float lodMorph;

uniform float amplitude;
uniform vec3 uPlanetCenter; // (optionnel) planet-local center, souvent (0,0,0)
uniform vec3 uPatchCenter;  // patch center (planet-local)

//------------------------------------------------------------------------------
// Varyings (to fragment shader)
//------------------------------------------------------------------------------
varying vec3 vPosition;   // planet-local
varying vec2 vUV;         // patch-relative UV
varying vec3 vNormal;     // planet-local normal
varying vec3 vWorldPos;   // render-space (world matrix applied)

void main(void) {
  // Displace in planet-local
  vec3 displacedPosition = position + morphDelta * lodMorph + normal * amplitude;

  // Varyings
  vPosition = displacedPosition;
  vNormal = normalize(normal);

  // Patch-stable spherical UV (debug/optional)
  vec3 diff = normalize(displacedPosition - uPatchCenter);
  float longitude = atan(diff.z, diff.x);
  float latitude = asin(diff.y);

  float uCoord = (longitude + 3.14159265) / (2.0 * 3.14159265);
  float vCoord = (latitude + 1.57079633) / 3.14159265;
  vUV = vec2(uCoord, vCoord);

  vec4 worldPos = world * vec4(displacedPosition, 1.0);
  vWorldPosRender = worldPos.xyz;

  // World position in render-space for shadow projection
  vec4 wpos = world * vec4(displacedPosition, 1.0);
  vWorldPos = wpos.xyz;

  // Clip-space
  gl_Position = worldViewProjection * vec4(displacedPosition, 1.0);
}
