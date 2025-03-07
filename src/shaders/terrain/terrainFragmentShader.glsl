#extension GL_OES_standard_derivatives : enable

/*
 * Planetary Terrain Shader with Normal Mapping
 *
 * This fragment shader samples the diffuse texture using an equirectangular projection,
 * the detail texture using triplanar mapping, and also samples a normal map.
 * The normal map perturbs the vertex normal to affect the lighting.
 */
precision highp float;

//------------------------------------------------------------------------------
// Varyings and Uniforms
//------------------------------------------------------------------------------
varying vec3 vPosition;    // World-space position from the vertex shader
varying vec3 vNormal;      // World-space normal from the vertex shader
varying float vHeight;     // Height value passed from the vertex shader
varying vec2 vUV;          // UV coordinates generated in the vertex shader

uniform sampler2D diffuseTexture; // Diffuse texture sampler
uniform float textureScale;       // Scale factor for the diffuse texture

uniform sampler2D detailTexture;  // Detail texture sampler
uniform float detailScale;        // Scale factor for the detail texture
uniform float detailBlend;        // Blend factor between diffuse and detail textures

uniform sampler2D normalMap;      // Normal map sampler
uniform float normalScale;        // Scale factor for normal perturbation

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
    // Échantillonner la texture diffuse avec une projection équirectangulaire
    vec4 diffuseColor = equirectangularProjection(vPosition, normalize(vNormal), textureScale, vec2(0.0));

    // Échantillonner la texture de détail via triplanar mapping
    vec2 detailOffset = vec2(0.5, 0.5);
    vec4 detailColor = triplanar(vPosition, normalize(vNormal), detailScale, detailOffset, true);

    // Combiner diffuse et détail
    vec4 combinedColor = mix(diffuseColor, diffuseColor * detailColor, detailBlend);

    // Échantillonner la normal map avec les UV (générées dans le vertex shader)
    vec3 normalSample = texture(normalMap, vUV).rgb;
    // Convertir de [0, 1] à [-1, 1]
    normalSample = normalize(normalSample * 2.0 - 1.0);

    // Combiner la normale du vertex avec celle du normal map
    vec3 finalNormal = normalize(vNormal + normalSample * normalScale);

    // Calcul d'un éclairage simple (dot produit avec le vecteur vertical)
    float lighting = clamp(dot(finalNormal, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);

    gl_FragColor = vec4(combinedColor.rgb * lighting, combinedColor.a);
  }
}
