/*
 * CBT terrain fragment shader — per-pixel diffuse lighting.
 * The surface normal is recomputed PER PIXEL from the procedural noise gradient
 * (see _cbtNoise.glsl), so shading is independent of the mesh tessellation and
 * does not pop when triangles split/merge.
 *
 * Logarithmic depth (LOGARITHMICDEPTH) writes gl_FragDepth so the planet renders
 * correctly across the full 1:1 depth range.
 */
precision highp float;
precision highp int;

varying vec3 vLocalPos;
varying vec2 vUv;
varying vec4 vColor;

uniform mat4 world;
uniform float uRadius;
uniform vec3 uLightDirection; // world-space, points star -> planet
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform vec3 uAlbedo;
uniform vec3 uAmbient;
uniform int uDebugLod;

#include<logDepthDeclaration>
#include<cbtNoise>

void main(void) {
    vec3 col;

    if (uDebugLod != 0) {
        col = vColor.rgb; // unlit LOD colours (X key)
    } else {
        vec3 dir = normalize(vLocalPos);
        vec3 nLocal = cbtNoiseNormal(dir, uRadius);
        vec3 nWorld = normalize(mat3(world) * nLocal); // assumes uniform scale

        vec3 L = normalize(-uLightDirection);
        float ndl = max(dot(nWorld, L), 0.0);

        vec3 lighting = uAmbient + uLightColor * (uLightIntensity * ndl);
        col = uAlbedo * lighting;
    }

    gl_FragColor = vec4(col, 1.0);
#include<logDepthFragment>
}
