precision highp float;
precision highp int;

//------------------------------------------------------------------------------
// Varyings (from vertex shader)
//------------------------------------------------------------------------------
varying vec3 vPosition;      // planet-local
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

// Shadows
uniform sampler2D shadowSampler;
uniform mat4 lightMatrix;
uniform vec2 shadowTexelSize;
uniform float shadowBias;
uniform float shadowNormalBias;
uniform float shadowDarkness;      // 0..1 (1 = ombres noires)
uniform float shadowReverseDepth;  // 1 si reverse depth buffer
uniform float shadowNdcHalfZRange; // 1 si WebGPU (z NDC 0..1)

float shadowDepthMetric(float clipZ) {
  float z01 = (shadowNdcHalfZRange > 0.5) ? clipZ : (clipZ * 0.5 + 0.5);

  float SMALLEST_ABOVE_ZERO = 1.1754943508e-38;
  float GREATEST_LESS_THAN_ONE = 0.99999994;

  if(shadowReverseDepth > 0.5) {
    return clamp(z01, SMALLEST_ABOVE_ZERO, 1.0);
  } else {
    return clamp(z01, 0.0, GREATEST_LESS_THAN_ONE);
  }
}

// returns 1 if lit, 0 if shadow
float isLit(float depthMetric, float mapDepth, float receiverBias) {
  if(shadowReverseDepth > 0.5) {
    // reverse: bigger = closer
    return (depthMetric + receiverBias >= mapDepth) ? 1.0 : 0.0;
  } else {
    return (depthMetric - receiverBias <= mapDepth) ? 1.0 : 0.0;
  }
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float computeShadowPoisson(vec3 worldPosRender, vec3 n, vec3 L) {
  vec4 p = lightMatrix * vec4(worldPosRender, 1.0);
  vec3 clip = p.xyz / p.w;

  vec2 uv = clip.xy * 0.5 + vec2(0.5);
  float z01 = (shadowNdcHalfZRange > 0.5) ? clip.z : (clip.z * 0.5 + 0.5);

  float inX = step(0.0, uv.x) * step(uv.x, 1.0);
  float inY = step(0.0, uv.y) * step(uv.y, 1.0);
  float inZ = step(0.0, z01) * step(z01, 1.0);
  float inFrustum = inX * inY * inZ;

  vec2 uvc = clamp(uv, vec2(0.0), vec2(1.0));
  float depthMetric = shadowDepthMetric(clip.z);
  float ndl = max(dot(n, L), 0.0);
  float receiverBias = shadowBias + (1.0 - ndl) * shadowNormalBias;

  const vec2 POISSON[12] = vec2[12](
    vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696,  0.457),
    vec2(-0.203,  0.621), vec2( 0.962, -0.195), vec2( 0.473, -0.480),
    vec2( 0.519,  0.767), vec2( 0.185, -0.893), vec2( 0.507,  0.064),
    vec2( 0.896,  0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
  );

  float angle = hash12(uvc * 8192.0) * 6.2831853;
  float s = sin(angle);
  float c = cos(angle);
  mat2 rot = mat2(c, -s, s, c);

  vec2 uvFootprint = fwidth(uvc);
  float footprintTexels = max(uvFootprint.x / max(shadowTexelSize.x, 1e-6), uvFootprint.y / max(shadowTexelSize.y, 1e-6));
  float ndlSoft = max(dot(n, L), 0.0);
  float radiusTexels = clamp(1.5 + footprintTexels * 0.6 + (1.0 - ndlSoft) * 1.5, 1.5, 6.0);

  float sum = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 off = (rot * POISSON[i]) * (radiusTexels * shadowTexelSize);
    float mapDepth = textureLod(shadowSampler, uvc + off, 0.0).r;
    sum += isLit(depthMetric, mapDepth, receiverBias);
  }

  float visibility = sum / 12.0; // 0..1 (lit)
  return mix(1.0, visibility, inFrustum); // outside frustum => lit
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

  float vis = computeShadowPoisson(vWorldPosRender, n, L);            // 0..1 (lit)
  float shadowFactor = mix(1.0 - shadowDarkness, 1.0, vis);           // lit=1, shadow=(1-darkness)

  vec3 lighting = ambient + diffuse * shadowFactor;
  gl_FragColor = vec4(combined.rgb * lighting, combined.a);
}
