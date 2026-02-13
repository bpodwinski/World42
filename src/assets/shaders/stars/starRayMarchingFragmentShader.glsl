uniform vec2 resolution;
uniform float time;

uniform vec3 cameraPositionRender; // Render-space
uniform vec3 starCenterRender;      // Render-space
uniform float starRadius;
uniform float tMax;

uniform vec3 starColor;
uniform float starIntensity;

uniform mat4 inverseProjection;
uniform mat4 inverseView;
uniform sampler2D textureSampler;

float remap(float value, float min1, float max1, float min2, float max2) {
    return min2 + (value - min1) * (max2 - min2) / (max1 - min1);
}

vec3 worldFromUV(vec2 UV, float depth01) {
    vec4 ndc = vec4(UV * 2.0 - 1.0, 0.0, 1.0);
    vec4 posVS = inverseProjection * ndc;

    posVS.xyz *= remap(depth01, 0.0, 1.0, 0.001, 1000000.0);

    vec4 posWS = inverseView * vec4(posVS.xyz, 1.0);
    return posWS.xyz;
}

float sdfSphere(vec3 p, vec3 c, float r) {
    return length(p - c) - r;
}

float rayMarch(vec3 ro, vec3 rd, out float glow) {
    float t = 0.0;
    glow = 0.0;
    bool hit = false;

    const int steps = 100;

  // Scale eps + threshold a bit with star size (keeps behavior reasonable)
    float hitEps = max(1.0, starRadius * 0.001);
    float threshold = max(80.0, starRadius * 0.05);

    for(int i = 0; i < steps; i++) {
        vec3 p = ro + t * rd;
        float d = sdfSphere(p, starCenterRender, starRadius);

        float glowContribution = 1.0 - smoothstep(0.0, threshold, d);
        glow += glowContribution * 0.2 * (1.0 + 0.3 * sin(time));

        if(!hit && d < hitEps)
            hit = true;

    // avoid tiny steps
        t += max(d, hitEps);

        if(t > tMax)
            break;
    }

    return hit ? t : -1.0;
}

void main() {
    vec2 safeRes = max(resolution.xy, vec2(1.0));
    vec2 uv = gl_FragCoord.xy / safeRes;
    vec3 sceneColor = texture2D(textureSampler, uv).rgb;

    if(starIntensity <= 0.0) {
        gl_FragColor = vec4(sceneColor, 1.0);
        return;
    }

    vec3 worldPos = worldFromUV(uv, 1.0);

    vec3 ro = cameraPositionRender;
    vec3 rd = normalize(worldPos - ro);

    float glow;
    float t = rayMarch(ro, rd, glow);

    vec3 add = glow * starColor * starIntensity;
    vec3 hdr = sceneColor + add;
    vec3 outColor = hdr / (vec3(1.0) + hdr);
    gl_FragColor = vec4(outColor, 1.0);
}
