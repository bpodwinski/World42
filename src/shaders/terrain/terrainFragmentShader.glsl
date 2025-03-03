/*
 * Planetary Terrain Shader
 *
 * This fragment shader implements triplanar texturing for a planetary terrain.
 * It blends a diffuse texture with a detail texture and includes optional debug
 * modes for visualizing UV coordinates and LOD levels.
 *
 */
precision highp float;

//------------------------------------------------------------------------------
// Varyings and Uniforms
//------------------------------------------------------------------------------
varying vec3 vPosition;    // World-space position from the vertex shader
varying vec3 vNormal;      // World-space normal from the vertex shader
varying float vHeight;     // Height value passed from the vertex shader

uniform sampler2D diffuseTexture; // Diffuse texture sampler
uniform float textureScale;       // Scale factor for the diffuse texture

uniform sampler2D detailTexture;  // Detail texture sampler
uniform float detailScale;        // Scale factor for the detail texture
uniform float detailBlend;        // Blend factor between diffuse and detail textures

// Debug mode uniforms
uniform bool debugUV;            // Toggle UV debug visualization
uniform bool debugLOD;           // Toggle LOD debug visualization
uniform float lodLevel;          // Current LOD level
uniform float lodMaxLevel;       // Maximum LOD level

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
    vec4 diffuseColor = triplanar(diffuseTexture, vPosition, normalize(vNormal), textureScale, vec2(0.0), false);
    vec2 detailOffset = vec2(0.05, 0.05);
    vec4 detailColor = triplanar(detailTexture, vPosition, normalize(vNormal), detailScale, detailOffset, true);
    vec4 combinedColor = mix(diffuseColor, diffuseColor * detailColor, detailBlend);
    float lighting = clamp(dot(normalize(vNormal), vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
    gl_FragColor = vec4(combinedColor.rgb * lighting, combinedColor.a);
  }
}
