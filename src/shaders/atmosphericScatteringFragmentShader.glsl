/*
 * Volumetric Atmospheric Scattering Shader for WebGL
 * Adapted and improved from Sebastian Lague's work
 * By Barthélemy Paléologue
 * 
 * Official repo: https://github.com/BarthPaleologue/volumetric-atmospheric-scattering
 */

precision highp float;

#define PI 3.1415926535897932
#define POINTS_FROM_CAMERA 16 // Number of sample points along the camera ray
#define OPTICAL_DEPTH_POINTS 8 // Number of sample points along the light ray

// Varying
varying vec2 vUV; // Screen coordinates

// Uniforms
uniform sampler2D textureSampler; // Original screen texture
uniform sampler2D depthSampler; // Depth map of the camera

uniform vec3 sunPosition; // Sun position in world space
uniform vec3 cameraPosition; // Camera position in world space

uniform mat4 inverseProjection; // Camera's inverse projection matrix
uniform mat4 inverseView; // Camera's inverse view matrix

uniform float cameraNear; // Camera minZ
uniform float cameraFar; // Camera maxZ

uniform vec3 planetPosition; // Planet position in world space
uniform float planetRadius; // Planet radius for height calculations (in meters)
uniform float atmosphereRadius; // Atmosphere radius (calculated from planet center) (in meters)

uniform float rayleighHeight; // Height falloff of Rayleigh scattering (in meters)
uniform vec3 rayleighCoeffs; // Rayleigh scattering coefficients

uniform float mieHeight; // Height falloff of Mie scattering (in meters)
uniform vec3 mieCoeffs; // Mie scattering coefficients
uniform float mieAsymmetry; // Mie scattering asymmetry (between -1 and 1)

uniform float ozoneHeight; // Height of ozone layer in meters above the surface
uniform vec3 ozoneCoeffs; // Ozone absorption coefficients
uniform float ozoneFalloff; // Ozone falloff around the ozone layer in meters

uniform float sunIntensity; // Controls overall atmosphere brightness

// Remaps a value from one range to another
float remap(float value, float low1, float high1, float low2, float high2) {
    return low2 + (value - low1) * (high2 - low2) / (high1 - low1);
}

// Compute the world position of a pixel from its UV coordinates and depth
vec3 worldFromUV(vec2 UV, float depth) {
    // Convert UV to normalized device coordinates
    vec4 ndc = vec4(UV * 2.0 - 1.0, 0.0, 1.0);

    // Unproject the pixel to view space
    vec4 posVS = inverseProjection * ndc;

    // Now account for the depth (we can't do it before because of the perspective projection being non uniform)
    posVS.xyz *= remap(depth, 0.0, 0.9, cameraNear, cameraFar);

    // Unproject the point to world space
    vec4 posWS = inverseView * vec4(posVS.xyz, 1.0);
    return posWS.xyz;
}

// remaps colors from [0, inf] to [0, 1]
vec3 acesTonemap(vec3 color) {
    mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    vec3 v = m1 * color;
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return clamp(m2 * (a / b), 0.0, 1.0);
}

// Determines whether a ray intersects a sphere, returning intersection points if applicable
// Explanation: https://viclw17.github.io/2018/07/16/raytracing-ray-sphere-intersection
bool rayIntersectSphere(vec3 rayOrigin, vec3 rayDir, vec3 spherePosition, float sphereRadius, out float t0, out float t1) {
    // rayOrigin in sphere space
    vec3 relativeOrigin = rayOrigin - spherePosition;

    float a = 1.0;
    float b = 2.0 * dot(relativeOrigin, rayDir);
    float c = dot(relativeOrigin, relativeOrigin) - sphereRadius * sphereRadius;

    float d = b * b - 4.0 * a * c;

    if(d < 0.0)
        // No intersection
        return false;

    float r0 = (-b - sqrt(d)) / (2.0 * a);
    float r1 = (-b + sqrt(d)) / (2.0 * a);

    t0 = min(r0, r1);
    t1 = max(r0, r1);

    return (t1 >= 0.0);
}

// Based on https://www.youtube.com/watch?v=DxfEbulyFcY by Sebastian Lague
vec3 densityAtPoint(vec3 densitySamplePoint) {
    // Compute height above the planet's surface
    float heightAboveSurface = length(densitySamplePoint - planetPosition) - planetRadius;

    // Compute Rayleigh and Mie scattering contributions
    vec3 density = vec3(exp(-heightAboveSurface / vec2(rayleighHeight, mieHeight * 0.1)), 0.0);

    // Compute ozone absorption
    float denom = (ozoneHeight - heightAboveSurface) / ozoneFalloff;
    density.z = (1.0 / (denom * denom + 1.0)) * density.x;

    return density;
}

vec3 opticalDepth(vec3 rayOrigin, vec3 rayDir, float rayLength) {

    // Compute step size for sampling along the ray
    float stepSize = rayLength / (float(OPTICAL_DEPTH_POINTS) - 1.0);

    // Starting point of the ray
    vec3 densitySamplePoint = rayOrigin;

    // Accumulator for optical depth
    vec3 accumulatedOpticalDepth = vec3(0.0);

    for(int i = 0; i < OPTICAL_DEPTH_POINTS; i++) {
        // Sample local density
        vec3 localDensity = densityAtPoint(densitySamplePoint);

        // Linear approximation: density is constant between sample points
        accumulatedOpticalDepth += localDensity * stepSize;

        // Move sample point along the ray
        densitySamplePoint += rayDir * stepSize;
    }

    return accumulatedOpticalDepth;
}

vec3 calculateLight(vec3 rayOrigin, vec3 rayDir, float rayLength, vec3 originalColor) {

    // First sampling point coming from camera ray
    vec3 samplePoint = rayOrigin;

    // Direction to the light source
    vec3 sunDir = normalize(sunPosition - planetPosition);

    // Ray length between sample points
    float stepSize = rayLength / (float(POINTS_FROM_CAMERA) - 1.0);

    vec3 inScatteredRayleigh = vec3(0.0);
    vec3 inScatteredMie = vec3(0.0);

    vec3 totalOpticalDepth = vec3(0.0);

    for(int i = 0; i < POINTS_FROM_CAMERA; i++) {
        // Distance traveled by light through atmosphere from light source
        float sunRayLengthInAtm = atmosphereRadius - length(samplePoint - planetPosition);
        float t0, t1;
        if(rayIntersectSphere(samplePoint, sunDir, planetPosition, atmosphereRadius, t0, t1)) {
            sunRayLengthInAtm = t1;
        }

        // Scattered from the sun to the point
        vec3 sunRayOpticalDepth = opticalDepth(samplePoint, sunDir, sunRayLengthInAtm);

        // Distance traveled by light through atmosphere from sample point to cameraPosition
        float viewRayLengthInAtm = stepSize * float(i);

        // Scattered from the point to the camera
        vec3 viewRayOpticalDepth = opticalDepth(samplePoint, -rayDir, viewRayLengthInAtm);

        // Now we need to calculate the transmittance
        // this is essentially how much light reaches the current sample point due to scattering
        vec3 transmittance = exp(-rayleighCoeffs * (sunRayOpticalDepth.x + viewRayOpticalDepth.x) - mieCoeffs * (sunRayOpticalDepth.y + viewRayOpticalDepth.y) - ozoneCoeffs * (sunRayOpticalDepth.z + viewRayOpticalDepth.z));

        // Density at sample point
        vec3 localDensity = densityAtPoint(samplePoint);
        totalOpticalDepth += localDensity * stepSize;

        // Add the resulting amount of light scattered toward the camera
        inScatteredRayleigh += localDensity.x * transmittance * stepSize;
        inScatteredMie += localDensity.y * transmittance * stepSize;

        // Move sample point along view ray
        samplePoint += rayDir * stepSize;
    }

    float costheta = dot(rayDir, sunDir);
    float costheta2 = costheta * costheta;

    // Scattering depends on the direction of the light ray and the view ray: it's the rayleigh phase function
    // https://glossary.ametsoc.org/wiki/Rayleigh_phase_function
    float phaseRayleigh = 3.0 / (16.0 * PI) * (1.0 + costheta2);

    float g = mieAsymmetry;
    float g2 = g * g;
    float phaseMie = ((3.0 * (1.0 - g2)) / (2.0 * (2.0 + g2))) * ((1.0 + costheta2) / pow(1.0 + g2 - 2.0 * g * costheta, 1.5));

    inScatteredRayleigh *= phaseRayleigh * rayleighCoeffs;
    inScatteredMie *= phaseMie * mieCoeffs;

    // Calculate how much light can pass through the atmosphere
    vec3 opacity = exp(-(mieCoeffs * totalOpticalDepth.y + rayleighCoeffs * totalOpticalDepth.x + ozoneCoeffs * totalOpticalDepth.z));

    return (inScatteredRayleigh + inScatteredMie) * sunIntensity + originalColor * opacity;
}

vec3 scatter(vec3 originalColor, vec3 rayOrigin, vec3 rayDir, float maximumDistance) {
    float impactPoint, escapePoint;
    if(!(rayIntersectSphere(rayOrigin, rayDir, planetPosition, atmosphereRadius, impactPoint, escapePoint))) {
        // If not intersecting with atmosphere, return original color
        return originalColor;
    }

    // Cannot be negative (the ray starts where the camera is in such a case)
    impactPoint = max(0.0, impactPoint);

    // Occlusion with other scene objects
    escapePoint = min(maximumDistance, escapePoint);

    // Probably doesn't need the max but for the sake of coherence the distance cannot be negative
    float distanceThroughAtmosphere = max(0.0, escapePoint - impactPoint);

    // First atmosphere point to be hit by the ray
    vec3 firstPointInAtmosphere = rayOrigin + rayDir * impactPoint;

    // Calculate Scattering
    return calculateLight(firstPointInAtmosphere, rayDir, distanceThroughAtmosphere, originalColor);
}

void main() {
    vec3 screenColor = texture2D(textureSampler, vUV).rgb;

    // Depth corresponding to the pixel in the depth map
    float depth = texture2D(depthSampler, vUV).r;

    // Deepest physical point from the camera in the direction of the pixel (occlusion)
    // if there is no occlusion, the deepest point is on the far plane
    vec3 deepestPoint = worldFromUV(vUV, depth) - cameraPosition;

    // Maxium ray length due to occlusion
    float maximumDistance = length(deepestPoint);

    // Normalized direction of the ray
    vec3 rayDir = deepestPoint / maximumDistance;

    // This will account for the non perfect sphere shape of the planet
    // as "t0" is exactly the distance to the planet, while maximumDistance suffers from the 
    // imperfect descretized and periodic geometry of the sphere
    // DO NOT USE IF your planet has landmasses
    float t0, t1;
    if(rayIntersectSphere(cameraPosition, rayDir, planetPosition, planetRadius, t0, t1)) {
        if(maximumDistance > t0 - 1.0)
            // -1.0 is to avoid some imprecision artifacts
            maximumDistance = t0;
    }

    // Color to be displayed on the screen
    vec3 finalColor = scatter(screenColor, cameraPosition, rayDir, maximumDistance);

    // Exposure
    finalColor *= 1.2;

    // Tonemapping
    finalColor = acesTonemap(finalColor);

    // Saturation
    float saturation = 1.2;
    vec3 grayscale = vec3(0.299, 0.587, 0.114) * finalColor;
    finalColor = mix(grayscale, finalColor, saturation);
    finalColor = clamp(finalColor, 0.0, 1.0);

    // Displaying final color
    gl_FragColor = vec4(finalColor, 1.0);
}