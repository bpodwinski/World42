#extension GL_OES_standard_derivatives : enable

/*
 * Planetary Terrain Shader with Detail Mapping
 *
 * Ce shader utilise le triplanar mapping pour échantillonner la texture diffuse et une texture de détail afin d'ajouter des variations locales
 */
precision highp float;

varying vec3 vPosition;           // Position en espace monde
varying vec2 vUV;                 // Coordonnées UV (pour debug éventuellement)

uniform sampler2D diffuseTexture; // Texture diffuse
uniform sampler2D detailTexture;  // Texture de détail

uniform float textureScale;       // Échelle pour la texture diffuse
uniform float detailScale;        // Échelle pour la texture de détail
uniform float detailBlend;        // Intensité du détail

// Uniforms pour le debug
uniform bool debugUV;             // Affichage des UV pour debug
uniform bool debugLOD;            // Affichage du LOD pour debug
uniform float lodLevel;           // LOD actuel
uniform float lodMaxLevel;        // LOD maximum

// Uniforms pour l'éclairage
uniform vec3 lightDirection;      // Direction de la lumière (normalisée)
uniform float lightIntensity;     // Intensité de la lumière

#include<debugLOD>

// Fonction de triplanar mapping pour la texture diffuse
vec4 sampleTriplanarDiffuse(vec3 pos, vec3 normal, float scale) {
  vec3 blending = abs(normal);
  blending = normalize(max(blending, 0.00001)); // Évite la division par zéro
  float bSum = blending.x + blending.y + blending.z;
  blending /= bSum;

  vec3 scaledPos = pos * scale;
  vec2 xUV = scaledPos.yz;
  vec2 yUV = scaledPos.xz;
  vec2 zUV = scaledPos.xy;

  vec4 xTex = texture(diffuseTexture, xUV);
  vec4 yTex = texture(diffuseTexture, yUV);
  vec4 zTex = texture(diffuseTexture, zUV);

  return xTex * blending.x + yTex * blending.y + zTex * blending.z;
}

// Fonction de triplanar mapping pour la texture de détail
vec4 sampleTriplanarDetail(vec3 pos, vec3 normal, float scale) {
  vec3 blending = abs(normal);
  blending = normalize(max(blending, 0.00001)); // Évite la division par zéro
  float bSum = blending.x + blending.y + blending.z;
  blending /= bSum;

  vec3 scaledPos = pos * scale;
  vec2 xUV = scaledPos.yz;
  vec2 yUV = scaledPos.xz;
  vec2 zUV = scaledPos.xy;

  vec4 xTex = texture(detailTexture, xUV);
  vec4 yTex = texture(detailTexture, yUV);
  vec4 zTex = texture(detailTexture, zUV);

  return xTex * blending.x + yTex * blending.y + zTex * blending.z;
}

void main(void) {
  if(debugLOD) {
    gl_FragColor = lodToColor(lodLevel, lodMaxLevel);
  } else if(debugUV) {
    gl_FragColor = showUV();
  } else {
    vec3 dPdx = dFdx(vPosition);
    vec3 dPdy = dFdy(vPosition);
    vec3 geomNormal = normalize(cross(dPdx, dPdy));
    vec3 normal = geomNormal;

    // Échantillonnage des textures diffuse et de détail par triplanar mapping
    vec4 baseColor = sampleTriplanarDiffuse(vPosition, normal, textureScale);
    vec4 detailColor = sampleTriplanarDetail(vPosition, normal, detailScale);
    vec4 combinedColor = mix(baseColor, baseColor * detailColor, detailBlend);

    // Calcul de l'éclairage
    float lighting = clamp(dot(normal, normalize(-lightDirection)), 0.0, 1.0) * lightIntensity;
    gl_FragColor = vec4(combinedColor.rgb * lighting, combinedColor.a);
  }
}
