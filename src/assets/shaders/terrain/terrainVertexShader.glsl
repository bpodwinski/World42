#define NUM_LOD_LEVELS 8

/*
 * Planetary Terrain Vertex Shader
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
attribute vec2 uv;

uniform mat4 worldViewProjection;
uniform float time;
uniform float amplitude;
uniform float frequency;
uniform float mesh_dim;           // Nombre de subdivisions (pour le morphing)
uniform float lodMaxLevel;        // Niveau de LOD maximum
uniform vec3 cameraPosition;
uniform vec3 uPlanetCenter;       // Centre global de la planète
uniform vec3 uPatchCenter;        // Centre du patch (calculé sur le CPU)

varying vec2 vUV;
varying vec3 vRadial;
varying vec3 vPosition;

void main(void) {
  // Calculer la position déplacée en déplaçant simplement le vertex le long de sa normale
  vec3 displacedPosition = position + normal * amplitude;

  // Générer des coordonnées UV basées sur le centre du patch
  vec3 diff = normalize(displacedPosition - uPatchCenter);
  float longitude = atan(diff.z, diff.x);
  float latitude = asin(diff.y);
  float uCoord = (longitude + 3.14159) / (2.0 * 3.14159);
  float vCoord = (latitude + 1.5708) / 3.14159;
  vUV = vec2(uCoord, vCoord);

  vPosition = displacedPosition;
  vRadial = normalize(displacedPosition - uPlanetCenter);

  gl_Position = worldViewProjection * vec4(displacedPosition, 1.0);
}
