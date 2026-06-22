/*
 * CBT terrain vertex shader.
 * Positions are planet-local (radially displaced on the CPU). We pass the local
 * position through so the fragment shader can recover the unit sample direction
 * (normalize(vLocalPos)) and compute the noise normal per-pixel.
 *
 * Logarithmic depth is enabled (LOGARITHMICDEPTH define) so the planet stays
 * visible across the full 1:1 depth range, matching the previous StandardMaterial
 * (useLogarithmicDepth = true).
 */
precision highp float;

attribute vec3 position; // planet-local (already displaced)
attribute vec2 uv;
attribute vec4 color;    // LOD debug colour

uniform mat4 world;
uniform mat4 worldViewProjection;

varying vec3 vLocalPos;
varying vec2 vUv;
varying vec4 vColor;

#include<logDepthDeclaration>

void main(void) {
    vLocalPos = position;
    vUv = uv;
    vColor = color;
    gl_Position = worldViewProjection * vec4(position, 1.0);
#include<logDepthVertex>
}
