#extension GL_OES_standard_derivatives : enable

/*
 * Planetary Terrain Shader without Normal Mapping
 *
 * This fragment shader samples the diffuse texture using an equirectangular projection,
 * and the detail texture using triplanar mapping.
 * It no longer samples a normal map, so vertex normals are used directly for lighting.
 */
precision highp float;

//------------------------------------------------------------------------------
// Varyings and Uniforms
//------------------------------------------------------------------------------
varying vec3 vPosition;    // World-space position from the vertex shader
varying vec3 vNormal;      // World-space normal from the vertex shader
varying vec2 vUV;          // UV coordinates generated in the vertex shader

uniform sampler2D diffuseTexture; // Diffuse texture sampler
uniform float textureScale;       // Scale factor for the diffuse texture

uniform sampler2D detailTexture;  // Detail texture sampler
uniform float detailScale;        // Scale factor for the detail texture
uniform float detailBlend;        // Blend factor between diffuse and detail textures

// Debug mode uniforms
uniform bool debugUV;             // Toggle UV debug visualization
uniform bool debugLOD;            // Toggle LOD debug visualization
uniform float lodLevel;           // Current LOD level
uniform float lodMaxLevel;        // Maximum LOD level

//------------------------------------------------------------------------------
// Includes
//------------------------------------------------------------------------------
#include<textureNoTile>
#include<triplanar>
#include<debugLOD>

void main(void) {
  if(debugLOD) {
    gl_FragColor = lodToColor(lodLevel, lodMaxLevel);
  } else if(debugUV) {
    gl_FragColor = showUV();
  } else {
    // Sample the diffuse texture using an equirectangular projection.
    vec4 diffuseColor = equirectangularProjection(vPosition, normalize(vNormal), textureScale, vec2(0.0));

    // Sample the detail texture using triplanar mapping.
    vec2 detailOffset = vec2(0.5, 0.5);
    vec4 detailColor = triplanar(vPosition, normalize(vNormal), detailScale, detailOffset, true);

    // Combine diffuse and detail textures.
    vec4 combinedColor = mix(diffuseColor, diffuseColor * detailColor, detailBlend);

    // Use the vertex normal directly for lighting.
    vec3 finalNormal = normalize(vNormal);

    // Simple lighting calculation (dot product with the vertical vector).
    float lighting = clamp(dot(finalNormal, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);

    gl_FragColor = vec4(combinedColor.rgb * lighting, combinedColor.a);
  }
}
