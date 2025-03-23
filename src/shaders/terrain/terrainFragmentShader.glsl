#extension GL_OES_standard_derivatives : enable

/*
 * Planetary Terrain Shader without Normal Mapping, Detail Mapping, or Detail Texture
 *
 * This fragment shader samples only the diffuse texture using an equirectangular projection.
 * Vertex normals are used directly for lighting.
 * A uniform 'lightDirection' is used to control the direction of the light,
 * and 'lightIntensity' to adjust the brightness.
 */
precision highp float;

varying vec3 vPosition;    // World-space position from the vertex shader
varying vec3 vNormal;      // World-space normal from the vertex shader
varying vec2 vUV;          // UV coordinates generated in the vertex shader

uniform sampler2D diffuseTexture; // Diffuse texture sampler
uniform float textureScale;       // Scale factor for the diffuse texture

// Debug mode uniforms
uniform bool debugUV;             // Toggle UV debug visualization
uniform bool debugLOD;            // Toggle LOD debug visualization
uniform float lodLevel;           // Current LOD level
uniform float lodMaxLevel;        // Maximum LOD level

// Uniforms for lighting
uniform vec3 lightDirection;      // Direction of the light (normalized)
uniform float lightIntensity;     // Intensity multiplier for the light

#include<debugLOD>

vec4 equirectangularProjection(vec3 pos, vec3 center, float scale, vec2 offset) {
  vec3 dir = normalize(pos - center);
  float longitude = atan(dir.z, dir.x);
  float latitude = asin(dir.y);
  float u = (longitude + 3.14159) / (2.0 * 3.14159);
  float v = (latitude + 1.5708) / 3.14159;
  vec2 uv = vec2(u, v);
  uv = uv * scale + offset;
  return texture(diffuseTexture, uv);
}

void main(void) {
  if(debugLOD) {
    gl_FragColor = lodToColor(lodLevel, lodMaxLevel);
  } else if(debugUV) {
    gl_FragColor = showUV();
  } else {
    // Sample the diffuse texture using an equirectangular projection.
    vec4 diffuseColor = equirectangularProjection(vPosition, normalize(vNormal), textureScale, vec2(0.0));

    // Use the vertex normal directly for lighting.
    vec3 finalNormal = normalize(vNormal);

    // Compute lighting with the custom light direction and apply light intensity.
    float lighting = clamp(dot(finalNormal, normalize(lightDirection)), 0.0, 1.0) * lightIntensity;

    gl_FragColor = vec4(diffuseColor.rgb * lighting, diffuseColor.a);
  }
}
