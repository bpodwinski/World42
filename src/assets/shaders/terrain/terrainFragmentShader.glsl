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
float isLit(float depthMetric, float mapDepth) {
  if(shadowReverseDepth > 0.5) {
    // reverse: bigger = closer
    return (depthMetric + shadowBias >= mapDepth) ? 1.0 : 0.0;
  } else {
    return (depthMetric - shadowBias <= mapDepth) ? 1.0 : 0.0;
  }
}

float computeShadowPCF3x3(vec3 worldPosRender) {
  vec4 p = lightMatrix * vec4(worldPosRender, 1.0);
  vec3 clip = p.xyz / p.w;

  vec2 uv = clip.xy * 0.5 + vec2(0.5);

  float inX = step(0.0, uv.x) * step(uv.x, 1.0);
  float inY = step(0.0, uv.y) * step(uv.y, 1.0);
  float inFrustum = inX * inY;

  vec2 uvc = clamp(uv, vec2(0.0), vec2(1.0));
  float depthMetric = shadowDepthMetric(clip.z);

  float sum = 0.0;
  for(int y = -1; y <= 1; y++) {
    for(int x = -1; x <= 1; x++) {
      vec2 off = vec2(float(x), float(y)) * shadowTexelSize;
      float mapDepth = textureLod(shadowSampler, uvc + off, 0.0).r;
      sum += isLit(depthMetric, mapDepth);
    }
  }

  float visibility = sum / 9.0; // 0..1 (lit)
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

  float vis = computeShadowPCF3x3(vWorldPosRender);                   // 0..1 (lit)
  float shadowFactor = mix(1.0 - shadowDarkness, 1.0, vis);           // lit=1, shadow=(1-darkness)

  vec3 lighting = ambient + diffuse * shadowFactor;
  gl_FragColor = vec4(combined.rgb * lighting, combined.a);
}
