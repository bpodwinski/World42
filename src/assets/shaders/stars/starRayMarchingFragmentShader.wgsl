// Star ray-march post-process (Frame Graph task), linear HDR. Renders the sun as an SDF sphere with a
// smooth glow, occluded by the nearest planet (analytic sphere) and by scene terrain (depth buffer).
// Render space is sim units (1 sim = 1 km), camera-relative (floating origin).
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

// Depth buffer for terrain occlusion.
var depthSamplerSampler: sampler;
var depthSampler: texture_2d<f32>;

uniform time: f32;
uniform cameraPositionRender: vec3f;
uniform starCenterRender: vec3f;
uniform starRadius: f32;
uniform tMax: f32;
uniform starColor: vec3f;
uniform starIntensity: f32;
uniform occluderCenter: vec3f;
uniform occluderRadius: f32;
// Same constant used by terrain shaders: 2.0 / log2(maxZ + 1). 0 = linear fallback.
uniform logarithmicDepthConstant: f32;
uniform cameraNear: f32;
uniform cameraFar: f32;
uniform inverseProjection: mat4x4f;
uniform inverseView: mat4x4f;

struct RayMarchResult {
    t: f32,
    glow: f32,
};

fn remap(value: f32, min1: f32, max1: f32, min2: f32, max2: f32) -> f32 {
    return min2 + (value - min1) * (max2 - min2) / (max1 - min1);
}

fn worldFromUV(uv: vec2f, depth01: f32) -> vec3f {
    var ndc: vec4f = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
    var posVS: vec4f = uniforms.inverseProjection * ndc;
    posVS = vec4f(posVS.xyz * remap(depth01, 0.0, 1.0, 0.001, 1000000.0), posVS.w);
    var posWS: vec4f = uniforms.inverseView * vec4f(posVS.xyz, 1.0);
    return posWS.xyz;
}

fn sdfSphere(p: vec3f, c: vec3f, r: f32) -> f32 {
    return length(p - c) - r;
}

// Decode depth buffer value to linear view-space distance.
// Matches the logarithmic depth encoding used by terrain shaders.
fn decodeDepth(rawDepth: f32) -> f32 {
    if (uniforms.logarithmicDepthConstant > 0.0) {
        var halfC: f32 = uniforms.logarithmicDepthConstant * 0.5;
        return pow(2.0, rawDepth / halfC) - 1.0;
    }
    var range: f32 = uniforms.cameraFar - uniforms.cameraNear;
    return rawDepth * range + uniforms.cameraNear;
}

// Returns nearest positive t where ray (ro+t*rd) first hits sphere (c,r), -1 if none.
fn raySphereNearest(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> f32 {
    var oc: vec3f = ro - c;
    var b: f32 = dot(oc, rd);
    var disc: f32 = b * b - (dot(oc, oc) - r * r);
    if (disc < 0.0) { return -1.0; }
    var sq: f32 = sqrt(disc);
    var t1: f32 = -b - sq;
    if (t1 > 0.0) { return t1; }
    var t2: f32 = -b + sq;
    if (t2 > 0.0) { return t2; }
    return -1.0;
}

fn rayMarch(ro: vec3f, rd: vec3f, tStop: f32) -> RayMarchResult {
    var t: f32 = 0.0;
    var glow: f32 = 0.0;
    var hit: bool = false;

    // Ray-march step count (per-pixel, always-on post-processing cost). 100 was overkill for an
    // SDF sphere with a smooth glow; 48 halves the loop with no visible change. Raise if the star
    // edge/glow shows banding or stepping artifacts.
    const steps: i32 = 48;

    // Scale eps + threshold a bit with star size (keeps behavior reasonable)
    var hitEps: f32 = max(1.0, uniforms.starRadius * 0.001);
    var threshold: f32 = max(80.0, uniforms.starRadius * 0.05);

    for (var i: i32 = 0; i < steps; i = i + 1) {
        var p: vec3f = ro + t * rd;
        var d: f32 = sdfSphere(p, uniforms.starCenterRender, uniforms.starRadius);

        var glowContribution: f32 = 1.0 - smoothstep(0.0, threshold, d);
        glow = glow + glowContribution * 0.2 * (1.0 + 0.3 * sin(uniforms.time));

        if (!hit && d < hitEps) {
            hit = true;
        }

        // avoid tiny steps
        t = t + max(d, hitEps);

        if (t > tStop) {
            break;
        }
    }

    var result: RayMarchResult;
    result.t = select(-1.0, t, hit);
    result.glow = glow;
    return result;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    var uv: vec2f = input.vUV;
    var sceneColor: vec3f = textureSample(textureSampler, textureSamplerSampler, uv).rgb;

    if (uniforms.starIntensity <= 0.0) {
        fragmentOutputs.color = vec4f(sceneColor, 1.0);
        return fragmentOutputs;
    }

    var worldPos: vec3f = worldFromUV(uv, 1.0);
    var ro: vec3f = uniforms.cameraPositionRender;
    var rd: vec3f = normalize(worldPos - ro);

    // Stop the march at the nearest planet surface so the star is occluded by the planet.
    var tStop: f32 = uniforms.tMax;
    if (uniforms.occluderRadius > 0.0) {
        var tPlanet: f32 = raySphereNearest(ro, rd, uniforms.occluderCenter, uniforms.occluderRadius);
        if (tPlanet > 0.0 && tPlanet < tStop) {
            tStop = tPlanet;
        }
    }

    // Also stop at scene geometry (terrain) using the depth buffer.
    var rawDepth: f32 = textureSample(depthSampler, depthSamplerSampler, uv).r;
    var sceneDistance: f32 = decodeDepth(rawDepth);
    if (sceneDistance > 0.0 && sceneDistance < tStop) {
        tStop = sceneDistance;
    }

    var march: RayMarchResult = rayMarch(ro, rd, tStop);

    var add: vec3f = march.glow * uniforms.starColor * uniforms.starIntensity;
    // Output linear HDR — tone-mapping is applied once by the image-processing task (ACES).
    fragmentOutputs.color = vec4f(sceneColor + add, 1.0);
    return fragmentOutputs;
}
