precision highp float;
precision highp int;

//------------------------------------------------------------------------------
// Varyings (from vertex shader)
//------------------------------------------------------------------------------
varying vec3 vPosition;       // planet-local
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vWorldPosRender; // render-space (world * position)

//------------------------------------------------------------------------------
// Textures
//------------------------------------------------------------------------------
uniform sampler2D diffuseTexture;
uniform sampler2D detailTexture;

//------------------------------------------------------------------------------
// Material controls
//------------------------------------------------------------------------------
uniform float textureScale;
uniform float detailScale;
uniform float detailBlend;

//------------------------------------------------------------------------------
// Debug flags
//------------------------------------------------------------------------------
uniform int debugUV;
uniform int debugLOD;
uniform float lodLevel;
uniform float lodMaxLevel;

//------------------------------------------------------------------------------
// Lighting
//------------------------------------------------------------------------------
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform float lightIntensity;

//------------------------------------------------------------------------------
// Patch data
//------------------------------------------------------------------------------
uniform vec3 uPatchCenter;

#include<debugLOD>

//------------------------------------------------------------------------------
// Shadows
//------------------------------------------------------------------------------
uniform sampler2D shadowSampler;
uniform mat4 lightMatrix;
uniform vec2 shadowTexelSize;
uniform float shadowBias;
uniform float shadowDarkness;      // 0..1 (1 = fully dark)
uniform float shadowReverseDepth;  // 1 if reverse depth buffer
uniform float shadowNdcHalfZRange; // 1 if WebGPU (NDC z is 0..1)

/**
 * Converts the projected clip-space Z to the depth metric used in the shadow map.
 * Handles WebGL vs WebGPU NDC conventions and reverse depth buffers.
 */
float shadowDepthMetric(float clipZ) {
  float z01 = (shadowNdcHalfZRange > 0.5) ? clipZ : (clipZ * 0.5 + 0.5);

  float SMALLEST_ABOVE_ZERO = 1.1754943508e-38;
  float GREATEST_LESS_THAN_ONE = 0.99999994;

  if(shadowReverseDepth > 0.5) {
    // Reverse depth: keep > 0 to avoid precision edge cases.
    return clamp(z01, SMALLEST_ABOVE_ZERO, 1.0);
  } else {
    return clamp(z01, 0.0, GREATEST_LESS_THAN_ONE);
  }
}

/**
 * Returns 1.0 if the point is lit, 0.0 if it is in shadow.
 * The comparison direction depends on reverse depth.
 */
float isLit(float depthMetric, float mapDepth) {
  if(shadowReverseDepth > 0.5) {
    // Reverse depth: bigger values are closer.
    return (depthMetric + shadowBias >= mapDepth) ? 1.0 : 0.0;
  } else {
    return (depthMetric - shadowBias <= mapDepth) ? 1.0 : 0.0;
  }
}

//------------------------------------------------------------------------------
// Poisson disk PCF (12 taps) with per-fragment rotation
//------------------------------------------------------------------------------
const vec2 POISSON[12] = vec2[](vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621), vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));

/** Cheap hash for per-fragment rotation (reduces visible banding patterns). */
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

/**
 * Poisson PCF shadow visibility (1 = lit, 0 = shadow).
 *
 * @param worldPosRender Fragment position in Render-space
 * @param bias          Depth bias (already tuned at CPU side)
 * @param texelSize     1 / shadowMapResolution for sampling offsets
 */
float computeShadowPoisson(vec3 worldPosRender, float bias, vec2 texelSize) {
  vec4 lp = lightMatrix * vec4(worldPosRender, 1.0);
  vec3 ndc = lp.xyz / lp.w;

  vec2 uv = ndc.xy * 0.5 + vec2(0.5);
  float depth = shadowDepthMetric(ndc.z);

  // Outside of the shadow map => treat as lit.
  if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 1.0;
  }

  // Rotate kernel per-fragment (reduces structured aliasing).
  float a = hash13(worldPosRender) * 6.2831853;
  float ca = cos(a), sa = sin(a);
  mat2 R = mat2(ca, -sa, sa, ca);

  // Kernel radius in texels. Tune: ~1.25 (sharper) .. ~2.5 (softer).
  float radius = 1.75;

  float sum = 0.0;
  for(int i = 0; i < 12; i++) {
    vec2 o = (R * POISSON[i]) * texelSize * radius;
    float mapDepth = textureLod(shadowSampler, uv + o, 0.0).r;
    sum += isLit(depth, mapDepth);
  }
  return sum / 12.0;
}

//------------------------------------------------------------------------------
// Triplanar weights
//------------------------------------------------------------------------------
vec3 triplanarWeights(vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0));
  return w / (w.x + w.y + w.z);
}

vec4 sampleTriplanarDiffuse(vec3 pos, vec3 n, float scale) {
  vec3 w = triplanarWeights(n);
  vec3 p = pos * scale;
  return texture(diffuseTexture, p.yz) * w.x +
    texture(diffuseTexture, p.xz) * w.y +
    texture(diffuseTexture, p.xy) * w.z;
}

vec4 sampleTriplanarDetail(vec3 pos, vec3 n, float scale) {
  vec3 w = triplanarWeights(n);
  vec3 p = pos * scale;
  return texture(detailTexture, p.yz) * w.x +
    texture(detailTexture, p.xz) * w.y +
    texture(detailTexture, p.xy) * w.z;
}

void main(void) {
  if(debugLOD != 0) {
    gl_FragColor = lodToColor(lodLevel, lodMaxLevel);
    return;
  }
  if(debugUV != 0) {
    gl_FragColor = showUV();
    return;
  }

  vec3 n = normalize(vNormal);

  vec4 baseColor = sampleTriplanarDiffuse(vPosition, n, textureScale);
  vec4 detailColor = sampleTriplanarDetail(vPosition - uPatchCenter, n, detailScale);
  vec4 combined = mix(baseColor, baseColor * detailColor, detailBlend);

  vec3 L = normalize(-lightDirection);
  float ndl = max(dot(n, L), 0.0);

  vec3 ambient = vec3(0.01);
  vec3 diffuse = lightColor * (ndl * lightIntensity);

  float vis = computeShadowPoisson(vWorldPosRender, shadowBias, shadowTexelSize);
  float shadowFactor = mix(1.0 - shadowDarkness, 1.0, vis);

  vec3 lighting = ambient + diffuse * shadowFactor;
  gl_FragColor = vec4(combined.rgb * lighting, combined.a);
}
