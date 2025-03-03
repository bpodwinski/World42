/**
 * Computes a pseudo-random noise value based on the input vector.
 *
 * @param p Input vector.
 * @return A noise value between 0.0 and 1.0.
 */
float noise(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
}
