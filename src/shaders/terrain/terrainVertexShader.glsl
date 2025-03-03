/*
 * Planetary Terrain Vertex Shader (Equirectangular Projection using Patch Center)
 *
 * Ce shader déplace les vertex d'un terrain planétaire en utilisant une height map
 * échantillonnée via une projection équirectangulaire. Plutôt que d'utiliser le centre global
 * (uPlanetCenter), on utilise uPatchCenter (centre du patch) pour obtenir des variations locales.
 */
precision highp float;

//------------------------------------------------------------------------------
// Attributs
//------------------------------------------------------------------------------
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv; // éventuellement non utilisé

//------------------------------------------------------------------------------
// Uniformes
//------------------------------------------------------------------------------
uniform mat4 worldViewProjection;
uniform float time;
uniform float amplitude;
uniform float frequency;
uniform float mesh_dim;           // Nombre de subdivisions (pour le morphing)
uniform float lodMaxLevel;        // Niveau de LOD maximum
uniform vec3 cameraPosition;
uniform vec3 uPlanetCenter;       // Centre global de la planète
uniform vec3 uPatchCenter;        // Centre du patch (calculé sur le CPU)

uniform sampler2D heightMap;
uniform float heightFactor;       // Facteur d'amplification pour le déplacement
uniform float textureScale;       // Échelle pour la projection UV

//------------------------------------------------------------------------------
// Varyings pour le Fragment Shader
//------------------------------------------------------------------------------
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vPosition;
varying float vHeight;

//------------------------------------------------------------------------------
// Includes (Noise et Morphing)
//------------------------------------------------------------------------------
#include<noise>
#include<morphing>

//------------------------------------------------------------------------------
// Fonction d'échantillonnage par projection équirectangulaire (utilise le centre du patch)
//------------------------------------------------------------------------------
vec4 equirectangularProjection(sampler2D tex, vec3 pos, vec3 center, float scale) {
    // Utiliser le centre du patch pour obtenir des variations locales
  vec3 dir = normalize(pos - center);
  float longitude = atan(dir.z, dir.x); // Valeur entre -pi et pi
  float latitude = asin(dir.y);         // Valeur entre -pi/2 et pi/2
  float u = (longitude + 3.14159) / (2.0 * 3.14159);
  float v = (latitude + 1.5708) / 3.14159;
  vec2 uvProj = vec2(u, v) * scale;
  return texture2D(tex, uvProj);
}

//------------------------------------------------------------------------------
// Fonction principale
//------------------------------------------------------------------------------
void main(void) {
    // Calculer la position déplacée via les fonctions de bruit et morphing.
  vec3 displacedPosition = computeDisplacedPosition(position, normal, amplitude, cameraPosition);

    // Échantillonner la height map en utilisant une projection équirectangulaire basée sur le centre du patch.
  vec4 heightSample = equirectangularProjection(heightMap, displacedPosition, uPatchCenter, textureScale);
  float height = heightSample.r;
  vHeight = height;

    // Appliquer le déplacement en fonction de la hauteur
  displacedPosition += normalize(normal) * height * heightFactor;

    // Générer des UV pour le fragment shader en utilisant le centre du patch
  vec3 diff = normalize(displacedPosition - uPatchCenter);
  float longitude = atan(diff.z, diff.x);
  float latitude = asin(diff.y);
  float uCoord = (longitude + 3.14159) / (2.0 * 3.14159);
  float vCoord = (latitude + 1.5708) / 3.14159;
  vUV = vec2(uCoord, vCoord);

  vPosition = displacedPosition;
  vNormal = normalize(normal);
  gl_Position = worldViewProjection * vec4(displacedPosition, 1.0);
}
