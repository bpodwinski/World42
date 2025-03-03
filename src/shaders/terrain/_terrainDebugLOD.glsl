//------------------------------------------------------------------------------
// Debug Utility Functions
//------------------------------------------------------------------------------

// Convert HSV to RGB
vec3 hsv2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return c.z * mix(vec3(1.0), rgb, c.y);
}

// Generate a color based on LOD level
vec4 lodToColor(float lodLevel, float lodMaxLevel) {
    float hue = clamp(lodLevel / lodMaxLevel, 0.0, 1.0);
    return vec4(hsv2rgb(vec3(hue, 1.0, 1.0)), 1.0);
}

// Debug function to visualize averaged UV coordinates
vec4 showUV() {
    vec2 xUV = vPosition.yz * textureScale;
    vec2 yUV = vPosition.xz * textureScale;
    vec2 zUV = vPosition.xy * textureScale;
    vec2 avgUV = fract((xUV + yUV + zUV) / 3.0);
    return vec4(avgUV, 0.0, 1.0);
}
