/*
 * Planetary Terrain Vertex Shader (Sans Heightmap)
 *
 * Ce shader déplace les vertex d'un terrain planétaire via du bruit et morphing, 
 * sans échantillonner de heightmap pour modifier l'altitude.
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

//------------------------------------------------------------------------------
// Varyings pour le Fragment Shader
//------------------------------------------------------------------------------
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vPosition;

//------------------------------------------------------------------------------
// Includes (Noise et Morphing)
//------------------------------------------------------------------------------
#include<noise>
#include<morphing>

//------------------------------------------------------------------------------
// Fonction principale
//------------------------------------------------------------------------------
void main(void) {
    // Calculer la position déplacée via les fonctions de bruit et morphing.
  vec3 displacedPosition = computeDisplacedPosition(position, normal, amplitude, cameraPosition);

  // Générer des coordonnées UV basées sur le centre du patch
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
