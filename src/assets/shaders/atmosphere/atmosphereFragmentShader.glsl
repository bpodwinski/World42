// Physically based (single-scattering) atmosphere - Rayleigh + Mie, analytic ray-march.
// Runs as a Frame Graph post-process between the star pass and TAA, in linear HDR (tone-mapping is
// applied later by the image-processing task). All distances are in kilometres (render space is sim
// units, 1 sim = 1 km). The planet centre is provided in render space (camera-relative, floating
// origin). The surface is bounded by the analytic planet sphere (terrain relief is negligible at
// planetary scale), so this pass does NOT sample the scene depth.
//
// NOTE: keep comments on their OWN lines, never trailing a `uniform ...;` declaration - Babylon's
// WebGPU uniform->UBO reorganization captures trailing text and re-emits it, breaking compilation.
uniform vec2 resolution;
uniform mat4 inverseProjection;
uniform mat4 inverseView;
uniform vec3 cameraPositionRender;
uniform vec3 planetCenterRender;
uniform float planetRadiusKm;
uniform float atmoTopKm;
uniform vec3 sunDirRender;
uniform float sunIntensity;
uniform vec3 betaR;
uniform float betaM;
uniform float rayleighScaleKm;
uniform float mieScaleKm;
uniform float mieG;
uniform sampler2D textureSampler;

#define VIEW_STEPS 24
#define LIGHT_STEPS 6
#define PI 3.14159265359

vec3 worldFromUV(vec2 UV) {
    vec4 ndc = vec4(UV * 2.0 - 1.0, 0.0, 1.0);
    vec4 posVS = inverseProjection * ndc;
    posVS.xyz *= 1000000.0;
    vec4 posWS = inverseView * vec4(posVS.xyz, 1.0);
    return posWS.xyz;
}

// Ray vs sphere centred at origin. Returns vec2(tNear, tFar); x > y means no hit.
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
}

// Optical depth (Rayleigh, Mie) along [0, tMax] of a ray starting at p0 (planet-centred).
vec2 opticalDepth(vec3 p0, vec3 rd, float tMax) {
    float odR = 0.0;
    float odM = 0.0;
    float dt = tMax / float(LIGHT_STEPS);
    float t = dt * 0.5;
    for (int i = 0; i < LIGHT_STEPS; i++) {
        vec3 p = p0 + rd * t;
        float h = max(length(p) - planetRadiusKm, 0.0);
        odR += exp(-h / rayleighScaleKm) * dt;
        odM += exp(-h / mieScaleKm) * dt;
        t += dt;
    }
    return vec2(odR, odM);
}

void main() {
    vec2 safeRes = max(resolution.xy, vec2(1.0));
    vec2 uv = gl_FragCoord.xy / safeRes;
    vec3 sceneColor = texture2D(textureSampler, uv).rgb;

    if (sunIntensity <= 0.0) {
        gl_FragColor = vec4(sceneColor, 1.0);
        return;
    }

    vec3 ro = cameraPositionRender;
    vec3 rd = normalize(worldFromUV(uv) - ro);
    vec3 p0 = ro - planetCenterRender;

    // Intersect the atmosphere shell.
    vec2 atmo = raySphere(p0, rd, atmoTopKm);
    if (atmo.x > atmo.y || atmo.y < 0.0) {
        gl_FragColor = vec4(sceneColor, 1.0);
        return;
    }

    float tStart = max(atmo.x, 0.0);
    float tEnd = atmo.y;

    // Bound at the analytic surface (the rendered terrain follows this sphere within a few km).
    vec2 planet = raySphere(p0, rd, planetRadiusKm);
    bool hitSurface = false;
    if (planet.x <= planet.y && planet.x > 0.0 && planet.x < tEnd) {
        tEnd = planet.x;
        hitSurface = true;
    }
    if (tEnd <= tStart) {
        gl_FragColor = vec4(sceneColor, 1.0);
        return;
    }

    float mieExtinction = betaM * 1.1;

    float mu = dot(rd, sunDirRender);
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    float g = mieG;
    float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) /
                   ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));

    float dt = (tEnd - tStart) / float(VIEW_STEPS);
    float t = tStart + dt * 0.5;
    vec3 inScatter = vec3(0.0);
    float odR = 0.0;
    float odM = 0.0;

    for (int i = 0; i < VIEW_STEPS; i++) {
        vec3 p = p0 + rd * t;
        float h = max(length(p) - planetRadiusKm, 0.0);
        float dR = exp(-h / rayleighScaleKm) * dt;
        float dM = exp(-h / mieScaleKm) * dt;
        odR += dR;
        odM += dM;

        vec2 lAtmo = raySphere(p, sunDirRender, atmoTopKm);
        vec2 lPlanet = raySphere(p, sunDirRender, planetRadiusKm);
        bool inShadow = (lPlanet.x <= lPlanet.y && lPlanet.y > 0.0);
        if (!inShadow && lAtmo.y > 0.0) {
            vec2 odL = opticalDepth(p, sunDirRender, lAtmo.y);
            // Mie extinction/scattering is grey (scalar) -> broadcast to vec3.
            vec3 tau = betaR * (odR + odL.x) + vec3(mieExtinction * (odM + odL.y));
            vec3 transmittance = exp(-tau);
            inScatter += (betaR * dR * phaseR + vec3(betaM * dM * phaseM)) * transmittance;
        }
        t += dt;
    }

    vec3 viewTransmittance = exp(-(betaR * odR + vec3(mieExtinction * odM)));
    vec3 bg = hitSurface ? sceneColor * viewTransmittance : sceneColor;
    vec3 color = bg + inScatter * sunIntensity;

    gl_FragColor = vec4(color, 1.0);
}
