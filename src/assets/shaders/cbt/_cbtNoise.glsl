/*
 * CBT procedural noise — GLSL port of src/systems/lod/cbt/cbt_noise.ts.
 *
 * Gustavson 3D simplex with ANALYTIC gradient + fbm, matching the CPU field
 * exactly (same constants + the same seeded permutation table, uploaded via the
 * uPerm[256] uniform). The analytic gradient lets the fragment shader recover the
 * surface normal per-pixel in one evaluation per octave (no finite differences),
 * so shading is decoupled from the mesh tessellation (no LOD pop).
 *
 * Because the terrain displacement is RADIAL (pos = dir * (radius + height)),
 * normalize(planet-local position) == the unit sample direction, so the per-pixel
 * normal lines up with the CPU-displaced geometry.
 */

uniform float uPerm[256];      // seeded permutation table (values 0..255)
uniform int   uOctaves;
uniform float uBaseFrequency;
uniform float uBaseAmplitude;
uniform float uLacunarity;
uniform float uPersistence;
uniform float uGlobalAmplitude;

const int CBT_MAX_OCTAVES = 12;

// 12 cube-edge gradients (GRAD3 in cbt_noise.ts)
const vec3 CBT_GRAD3[12] = vec3[12](
    vec3( 1.0,  1.0, 0.0), vec3(-1.0,  1.0, 0.0), vec3( 1.0, -1.0, 0.0), vec3(-1.0, -1.0, 0.0),
    vec3( 1.0,  0.0, 1.0), vec3(-1.0,  0.0, 1.0), vec3( 1.0,  0.0,-1.0), vec3(-1.0,  0.0,-1.0),
    vec3( 0.0,  1.0, 1.0), vec3( 0.0, -1.0, 1.0), vec3( 0.0,  1.0,-1.0), vec3( 0.0, -1.0,-1.0)
);

// perm[] lookup with wrapping (the CPU duplicates to 512; & 255 is equivalent).
int cbtPerm(int i) {
    return int(uPerm[i & 255] + 0.5);
}

// One simplex corner contribution: accumulates value (n) and analytic gradient.
// d = offset (point - corner), g = corner gradient vector.
// contribution = (0.6 - |d|^2)^4 * dot(g, d);  derivative wrt p:
//   t^4 * g - 8 * t^3 * dot(g,d) * d   (t = 0.6 - |d|^2)
void cbtCorner(vec3 d, int gi, inout float n, inout vec3 grad) {
    float t = 0.6 - dot(d, d);
    if (t <= 0.0) return;
    vec3 g = CBT_GRAD3[gi % 12];
    float gd = dot(g, d);
    float t2 = t * t;
    float t3 = t2 * t;
    float t4 = t2 * t2;
    n += t4 * gd;
    grad += t4 * g - 8.0 * t3 * gd * d;
}

// Returns vec4(value, d/dx, d/dy, d/dz). value ~ [-1, 1].
vec4 cbtSimplex3_d(vec3 p) {
    const float F3 = 1.0 / 3.0;
    const float G3 = 1.0 / 6.0;

    float s = (p.x + p.y + p.z) * F3;
    vec3 ijk = floor(p + vec3(s));
    float t = (ijk.x + ijk.y + ijk.z) * G3;
    vec3 p0 = p - (ijk - vec3(t)); // x0,y0,z0

    // Simplex corner traversal order (matches cbt_noise.ts branches).
    vec3 e1, e2;
    if (p0.x >= p0.y) {
        if (p0.y >= p0.z)      { e1 = vec3(1.0, 0.0, 0.0); e2 = vec3(1.0, 1.0, 0.0); }
        else if (p0.x >= p0.z) { e1 = vec3(1.0, 0.0, 0.0); e2 = vec3(1.0, 0.0, 1.0); }
        else                   { e1 = vec3(0.0, 0.0, 1.0); e2 = vec3(1.0, 0.0, 1.0); }
    } else {
        if (p0.y < p0.z)       { e1 = vec3(0.0, 0.0, 1.0); e2 = vec3(0.0, 1.0, 1.0); }
        else if (p0.x < p0.z)  { e1 = vec3(0.0, 1.0, 0.0); e2 = vec3(0.0, 1.0, 1.0); }
        else                   { e1 = vec3(0.0, 1.0, 0.0); e2 = vec3(1.0, 1.0, 0.0); }
    }

    vec3 p1 = p0 - e1 + vec3(G3);
    vec3 p2 = p0 - e2 + vec3(2.0 * G3);
    vec3 p3 = p0 - vec3(1.0) + vec3(3.0 * G3);

    ivec3 ii = ivec3(ijk) & 255;
    ivec3 e1i = ivec3(e1);
    ivec3 e2i = ivec3(e2);

    float n = 0.0;
    vec3 grad = vec3(0.0);

    int gi0 = cbtPerm(ii.x +           cbtPerm(ii.y +           cbtPerm(ii.z)));
    int gi1 = cbtPerm(ii.x + e1i.x +   cbtPerm(ii.y + e1i.y +   cbtPerm(ii.z + e1i.z)));
    int gi2 = cbtPerm(ii.x + e2i.x +   cbtPerm(ii.y + e2i.y +   cbtPerm(ii.z + e2i.z)));
    int gi3 = cbtPerm(ii.x + 1 +       cbtPerm(ii.y + 1 +       cbtPerm(ii.z + 1)));

    cbtCorner(p0, gi0, n, grad);
    cbtCorner(p1, gi1, n, grad);
    cbtCorner(p2, gi2, n, grad);
    cbtCorner(p3, gi3, n, grad);

    return vec4(32.0 * n, 32.0 * grad);
}

// fbm with analytic gradient. Returns vec4(height, dHeight/dp.xyz).
vec4 cbtFbm_d(vec3 p) {
    float sum = 0.0;
    float maxPossible = 0.0;
    vec3 grad = vec3(0.0);
    float freq = uBaseFrequency;
    float amp = uBaseAmplitude;

    for (int i = 0; i < CBT_MAX_OCTAVES; i++) {
        if (i >= uOctaves) break;
        vec4 sd = cbtSimplex3_d(p * freq);
        sum += sd.x * amp;
        grad += sd.yzw * (amp * freq); // chain rule: input scaled by freq
        maxPossible += amp;
        freq *= uLacunarity;
        amp *= uPersistence;
    }

    if (maxPossible <= 1e-12) return vec4(0.0);
    float inv = uGlobalAmplitude / maxPossible;
    return vec4(sum * inv, grad * inv);
}

// Sphere tangent/bitangent basis (matches sphereTangents in cbt_emit.ts).
void cbtSphereTangents(vec3 nrm, out vec3 tang, out vec3 bitan) {
    vec3 a = (abs(nrm.y) > 0.9) ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    tang = normalize(cross(nrm, a));
    bitan = cross(nrm, tang);
}

// Per-pixel surface normal (matches noiseNormal in cbt_emit.ts, but using the
// analytic gradient instead of finite differences). The tangential components of
// the fbm gradient are the directional height derivatives along (t, b).
vec3 cbtNoiseNormal(vec3 dir, float radius) {
    vec3 nrm = normalize(dir);
    vec3 tang, bitan;
    cbtSphereTangents(nrm, tang, bitan);

    vec3 grad = cbtFbm_d(nrm).yzw;
    float dhdt = dot(grad, tang);
    float dhdb = dot(grad, bitan);

    float sc = 1.0 / radius;
    vec3 pn = nrm - dhdt * sc * tang - dhdb * sc * bitan;
    return normalize(pn);
}
