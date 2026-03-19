/**
 * Compact 3D simplex noise + FBM for CBT terrain displacement.
 * Based on Stefan Gustavson's simplex noise (public domain).
 */

// Gradient table (12 edges of a cube)
const GRAD3: ReadonlyArray<readonly [number, number, number]> = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

// Permutation table (seeded)
function buildPerm(seed: number): Uint8Array {
    const p = new Uint8Array(512);
    // Initialize with identity
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle with seed
    let s = seed | 0;
    for (let i = 255; i > 0; i--) {
        s = (s * 1664525 + 1013904223) | 0;
        const j = ((s >>> 0) % (i + 1));
        const tmp = p[i];
        p[i] = p[j];
        p[j] = tmp;
    }
    // Duplicate for wrapping
    for (let i = 0; i < 256; i++) p[i + 256] = p[i];
    return p;
}

const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;

function dot3(g: readonly [number, number, number], x: number, y: number, z: number): number {
    return g[0] * x + g[1] * y + g[2] * z;
}

function simplex3(perm: Uint8Array, x: number, y: number, z: number): number {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);

    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);

    let i1: number, j1: number, k1: number;
    let i2: number, j2: number, k2: number;

    if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2.0 * G3;
    const y2 = y0 - j2 + 2.0 * G3;
    const z2 = z0 - k2 + 2.0 * G3;
    const x3 = x0 - 1.0 + 3.0 * G3;
    const y3 = y0 - 1.0 + 3.0 * G3;
    const z3 = z0 - 1.0 + 3.0 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let n = 0.0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
        t0 *= t0;
        const gi0 = perm[ii + perm[jj + perm[kk]]] % 12;
        n += t0 * t0 * dot3(GRAD3[gi0], x0, y0, z0);
    }

    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
        t1 *= t1;
        const gi1 = perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] % 12;
        n += t1 * t1 * dot3(GRAD3[gi1], x1, y1, z1);
    }

    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
        t2 *= t2;
        const gi2 = perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] % 12;
        n += t2 * t2 * dot3(GRAD3[gi2], x2, y2, z2);
    }

    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
        t3 *= t3;
        const gi3 = perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] % 12;
        n += t3 * t3 * dot3(GRAD3[gi3], x3, y3, z3);
    }

    return 32.0 * n; // Range approximately [-1, 1]
}

export type NoiseParams = {
    seed: number;
    octaves: number;
    baseFrequency: number;
    baseAmplitude: number;
    lacunarity: number;
    persistence: number;
    globalAmplitude: number;
};

export const DEFAULT_NOISE: NoiseParams = {
    seed: 1,
    octaves: 8,
    baseFrequency: 8.0,
    baseAmplitude: 10.0,
    lacunarity: 2.0,
    persistence: 0.45,
    globalAmplitude: 15.0,
};

let cachedPerm: Uint8Array | null = null;
let cachedSeed = -1;

function getPerm(seed: number): Uint8Array {
    if (cachedSeed !== seed || !cachedPerm) {
        cachedPerm = buildPerm(seed);
        cachedSeed = seed;
    }
    return cachedPerm;
}

/**
 * Fractal Brownian Motion noise at a 3D point.
 * Returns a value in approximately [-globalAmplitude, +globalAmplitude].
 */
export function fbmNoise(
    x: number, y: number, z: number,
    params: NoiseParams
): number {
    const perm = getPerm(params.seed);
    let sum = 0;
    let maxPossible = 0;
    let freq = params.baseFrequency;
    let amp = params.baseAmplitude;

    for (let i = 0; i < params.octaves; i++) {
        sum += simplex3(perm, x * freq, y * freq, z * freq) * amp;
        maxPossible += amp;
        freq *= params.lacunarity;
        amp *= params.persistence;
    }

    return maxPossible > 1e-12
        ? (sum / maxPossible) * params.globalAmplitude
        : 0;
}
