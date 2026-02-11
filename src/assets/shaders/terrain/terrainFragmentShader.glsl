precision highp float;

//------------------------------------------------------------------------------
// Varyings (from vertex shader)
//------------------------------------------------------------------------------
varying vec3 vPosition;  // Displaced position in planet-local space
varying vec2 vUV;        // Patch-relative UVs (mainly for debug / optional use)
varying vec3 vNormal;    // Smoothed/interpolated normal

//------------------------------------------------------------------------------
// Textures
//------------------------------------------------------------------------------
uniform sampler2D diffuseTexture; // Base terrain albedo (used by triplanar)
uniform sampler2D detailTexture;  // High-frequency detail overlay (triplanar)

//------------------------------------------------------------------------------
// Material controls
//------------------------------------------------------------------------------
uniform float textureScale; // Base texture frequency (smaller = larger features)
uniform float detailScale;  // Detail texture frequency (smaller = larger detail features)
uniform float detailBlend;  // 0..1 how much detail influences the base

//------------------------------------------------------------------------------
// Debug flags
//------------------------------------------------------------------------------
uniform bool debugUV;
uniform bool debugLOD;
uniform float lodLevel;
uniform float lodMaxLevel;

//------------------------------------------------------------------------------
// Lighting
//------------------------------------------------------------------------------
uniform vec3 lightDirection; // Directional light direction (world/planet space, must match normal space)
uniform vec3 lightColor;     // RGB light color
uniform float lightIntensity;

//------------------------------------------------------------------------------
// Patch data
//------------------------------------------------------------------------------
uniform vec3 uPatchCenter;   // Patch center (planet-local) used to stabilize detail coordinates

#include<debugLOD>

//------------------------------------------------------------------------------
// Triplanar blending weights
// - Higher exponent => sharper transitions between axes.
//------------------------------------------------------------------------------
vec3 triplanarWeights(vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0)); // sharpness
  return w / (w.x + w.y + w.z);
}

//------------------------------------------------------------------------------
// Triplanar sampling for the base diffuse texture
// NOTE: Kept as a dedicated function (no sampler passed as parameter) to stay
// compatible with Babylon WebGPU GLSL->SPIR-V pipeline.
//------------------------------------------------------------------------------
vec4 sampleTriplanarDiffuse(vec3 pos, vec3 n, float scale) {
  vec3 w = triplanarWeights(n);
  vec3 p = pos * scale;

  // Project onto the three axis-aligned planes and blend
  return texture(diffuseTexture, p.yz) * w.x +
    texture(diffuseTexture, p.xz) * w.y +
    texture(diffuseTexture, p.xy) * w.z;
}

//------------------------------------------------------------------------------
// Triplanar sampling for the detail texture
// Uses the same projection but sampled from detailTexture.
//------------------------------------------------------------------------------
vec4 sampleTriplanarDetail(vec3 pos, vec3 n, float scale) {
  vec3 w = triplanarWeights(n);
  vec3 p = pos * scale;

  return texture(detailTexture, p.yz) * w.x +
    texture(detailTexture, p.xz) * w.y +
    texture(detailTexture, p.xy) * w.z;
}

void main(void) {
  // Debug LOD visualization
  if(debugLOD) {
    gl_FragColor = lodToColor(lodLevel, lodMaxLevel);
    return;
  }

  // Debug UV visualization
  if(debugUV) {
    gl_FragColor = showUV();
    return;
  }

  // Normalize the interpolated normal for lighting and triplanar blending
  vec3 n = normalize(vNormal);

  // Base is sampled using planet-local coordinates.
  // Detail is sampled using patch-local coordinates to avoid precision issues
  // at very large planet scales (vPosition can become huge).
  vec4 baseColor = sampleTriplanarDiffuse(vPosition, n, textureScale);
  vec4 detailColor = sampleTriplanarDetail(vPosition - uPatchCenter, n, detailScale);

  // Combine base and detail (multiplicative detail modulates the base)
  vec4 combined = mix(baseColor, baseColor * detailColor, detailBlend);

  // Simple directional lighting (Lambert)
  vec3 L = normalize(-lightDirection);
  float ndl = max(dot(n, L), 0.0);

  // Small ambient term to avoid fully black unlit areas
  vec3 ambient = vec3(0.01);
  vec3 diffuse = lightColor * (ndl * lightIntensity);

  // Final shaded color
  gl_FragColor = vec4(combined.rgb * (ambient + diffuse), combined.a);
}
