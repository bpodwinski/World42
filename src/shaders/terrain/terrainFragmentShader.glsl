#extension GL_OES_standard_derivatives : enable

/*
 * Planetary Terrain Shader without Normal Mapping, Detail Mapping, or Detail Texture
 *
 * This fragment shader samples the diffuse texture using triplanar mapping.
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

// Triplanar texture sampling function
vec4 triplanarMapping(vec3 pos, vec3 normal) {
  vec3 blending = abs(normal);
  blending = normalize(max(blending, 0.00001)); // Avoid division by zero
  float bSum = blending.x + blending.y + blending.z;
  blending /= bSum;

  // Scale world position for texture tiling
  vec3 scaledPos = pos * textureScale;

  vec2 xUV = scaledPos.yz;
  vec2 yUV = scaledPos.xz;
  vec2 zUV = scaledPos.xy;

  vec4 xTex = texture(diffuseTexture, xUV);
  vec4 yTex = texture(diffuseTexture, yUV);
  vec4 zTex = texture(diffuseTexture, zUV);

  return xTex * blending.x + yTex * blending.y + zTex * blending.z;
}

void main(void) {
  if(debugLOD) {
    gl_FragColor = lodToColor(lodLevel, lodMaxLevel);
  } else if(debugUV) {
    gl_FragColor = showUV();
  } else {
    // Sample the diffuse texture using triplanar mapping.
    vec4 diffuseColor = triplanarMapping(vPosition, normalize(vNormal));

    // Use the vertex normal directly for lighting.
    vec3 finalNormal = normalize(vNormal);

    // Compute lighting with the custom light direction and apply light intensity.
    float lighting = clamp(dot(finalNormal, normalize(lightDirection)), 0.0, 1.0) * lightIntensity;

    gl_FragColor = vec4(diffuseColor.rgb * lighting, diffuseColor.a);
  }
}
