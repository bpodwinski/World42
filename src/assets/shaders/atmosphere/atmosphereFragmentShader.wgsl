// Physically based (single-scattering) atmosphere - Rayleigh + Mie, analytic ray-march.
// Runs as a Frame Graph post-process between the star pass and TAA, in linear HDR (tone-mapping is
// applied later by the image-processing task). All distances are in kilometres (render space is sim
// units, 1 sim = 1 km). The planet centre is provided in render space (camera-relative, floating
// origin). The surface is bounded by the analytic planet sphere (terrain relief is negligible at
// planetary scale), so this pass does NOT sample the scene depth.
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

uniform inverseProjection: mat4x4f;
uniform inverseView: mat4x4f;
uniform cameraPositionRender: vec3f;
uniform planetCenterRender: vec3f;
uniform planetRadiusKm: f32;
uniform atmoTopKm: f32;
uniform sunDirRender: vec3f;
uniform sunIntensity: f32;
uniform betaR: vec3f;
uniform betaM: f32;
uniform rayleighScaleKm: f32;
uniform mieScaleKm: f32;
uniform mieG: f32;

const VIEW_STEPS: i32 = 24;
const LIGHT_STEPS: i32 = 6;
const PI: f32 = 3.14159265359;

fn worldFromUV(uv: vec2f) -> vec3f {
    var ndc: vec4f = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
    var posVS: vec4f = uniforms.inverseProjection * ndc;
    posVS = vec4f(posVS.xyz * 1000000.0, posVS.w);
    var posWS: vec4f = uniforms.inverseView * vec4f(posVS.xyz, 1.0);
    return posWS.xyz;
}

// Ray vs sphere centred at origin. Returns vec2(tNear, tFar); x > y means no hit.
fn raySphere(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
    var b: f32 = dot(ro, rd);
    var c: f32 = dot(ro, ro) - radius * radius;
    var disc: f32 = b * b - c;
    if (disc < 0.0) { return vec2f(1.0, -1.0); }
    var s: f32 = sqrt(disc);
    return vec2f(-b - s, -b + s);
}

// Optical depth (Rayleigh, Mie) along [0, tMax] of a ray starting at p0 (planet-centred).
fn opticalDepth(p0: vec3f, rd: vec3f, tMax: f32) -> vec2f {
    var odR: f32 = 0.0;
    var odM: f32 = 0.0;
    var dt: f32 = tMax / f32(LIGHT_STEPS);
    var t: f32 = dt * 0.5;
    for (var i: i32 = 0; i < LIGHT_STEPS; i = i + 1) {
        var p: vec3f = p0 + rd * t;
        var h: f32 = max(length(p) - uniforms.planetRadiusKm, 0.0);
        odR = odR + exp(-h / uniforms.rayleighScaleKm) * dt;
        odM = odM + exp(-h / uniforms.mieScaleKm) * dt;
        t = t + dt;
    }
    return vec2f(odR, odM);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    var uv: vec2f = input.vUV;
    var sceneColor: vec3f = textureSample(textureSampler, textureSamplerSampler, uv).rgb;

    if (uniforms.sunIntensity <= 0.0) {
        fragmentOutputs.color = vec4f(sceneColor, 1.0);
        return fragmentOutputs;
    }

    var ro: vec3f = uniforms.cameraPositionRender;
    var rd: vec3f = normalize(worldFromUV(uv) - ro);
    var p0: vec3f = ro - uniforms.planetCenterRender;

    // Intersect the atmosphere shell.
    var atmo: vec2f = raySphere(p0, rd, uniforms.atmoTopKm);
    if (atmo.x > atmo.y || atmo.y < 0.0) {
        fragmentOutputs.color = vec4f(sceneColor, 1.0);
        return fragmentOutputs;
    }

    var tStart: f32 = max(atmo.x, 0.0);
    var tEnd: f32 = atmo.y;

    // Bound at the analytic surface (the rendered terrain follows this sphere within a few km).
    var planet: vec2f = raySphere(p0, rd, uniforms.planetRadiusKm);
    var hitSurface: bool = false;
    if (planet.x <= planet.y && planet.x > 0.0 && planet.x < tEnd) {
        tEnd = planet.x;
        hitSurface = true;
    }
    if (tEnd <= tStart) {
        fragmentOutputs.color = vec4f(sceneColor, 1.0);
        return fragmentOutputs;
    }

    var mieExtinction: f32 = uniforms.betaM * 1.1;

    var mu: f32 = dot(rd, uniforms.sunDirRender);
    var phaseR: f32 = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    var g: f32 = uniforms.mieG;
    var phaseM: f32 = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) /
                      ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));

    var dt: f32 = (tEnd - tStart) / f32(VIEW_STEPS);
    var t: f32 = tStart + dt * 0.5;
    var inScatter: vec3f = vec3f(0.0);
    var odR: f32 = 0.0;
    var odM: f32 = 0.0;

    for (var i: i32 = 0; i < VIEW_STEPS; i = i + 1) {
        var p: vec3f = p0 + rd * t;
        var h: f32 = max(length(p) - uniforms.planetRadiusKm, 0.0);
        var dR: f32 = exp(-h / uniforms.rayleighScaleKm) * dt;
        var dM: f32 = exp(-h / uniforms.mieScaleKm) * dt;
        odR = odR + dR;
        odM = odM + dM;

        var lAtmo: vec2f = raySphere(p, uniforms.sunDirRender, uniforms.atmoTopKm);
        var lPlanet: vec2f = raySphere(p, uniforms.sunDirRender, uniforms.planetRadiusKm);
        var inShadow: bool = (lPlanet.x <= lPlanet.y && lPlanet.y > 0.0);
        if (!inShadow && lAtmo.y > 0.0) {
            var odL: vec2f = opticalDepth(p, uniforms.sunDirRender, lAtmo.y);
            // Mie extinction/scattering is grey (scalar) -> broadcast to vec3.
            var tau: vec3f = uniforms.betaR * (odR + odL.x) + vec3f(mieExtinction * (odM + odL.y));
            var transmittance: vec3f = exp(-tau);
            inScatter = inScatter + (uniforms.betaR * dR * phaseR + vec3f(uniforms.betaM * dM * phaseM)) * transmittance;
        }
        t = t + dt;
    }

    var viewTransmittance: vec3f = exp(-(uniforms.betaR * odR + vec3f(mieExtinction * odM)));
    var bg: vec3f = select(sceneColor, sceneColor * viewTransmittance, hitSurface);
    var color: vec3f = bg + inScatter * uniforms.sunIntensity;

    fragmentOutputs.color = vec4f(color, 1.0);
    return fragmentOutputs;
}
