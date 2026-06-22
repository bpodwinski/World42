/**
 * Generates the bit-exact reference fixture for the Rust cbt_noise port.
 *
 * Imports the REAL TypeScript noise field (src/.../cbt_noise.ts) and dumps:
 *  - P lines: noise param sets (seed, octaves, and f64 params as IEEE-754 bits)
 *  - N lines: fbmNoise(x,y,z) samples (inputs + result, all as f64 bits)
 *  - M lines: buildPerm(seed) permutation tables (512 u8 values)
 *
 * f64 values are emitted as 16-hex-digit IEEE-754 bit patterns so the Rust test
 * feeds identical inputs and compares results with ZERO round-trip ambiguity.
 *
 * Run (Node 24, native type stripping):
 *   node terrain/tools/gen_noise_fixture.ts
 * Writes terrain/tests/cbt_noise_fixture.txt (committed; consumed by cargo test).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildPerm,
    fbmNoise,
    DEFAULT_NOISE,
    type NoiseParams,
} from '../../src/systems/lod/cbt/cbt_noise.ts';

const buf = new ArrayBuffer(8);
const f = new Float64Array(buf);
const u = new BigUint64Array(buf);
function bits(x: number): string {
    f[0] = x;
    return u[0].toString(16).padStart(16, '0');
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'tests', 'cbt_noise_fixture.txt');

// Param sets: DEFAULT_NOISE plus quality-preset octave counts and seed variants
// (including a negative seed to exercise the `s | 0` / `>>> 0` LCG semantics).
const paramSets: NoiseParams[] = [
    { ...DEFAULT_NOISE },
    { ...DEFAULT_NOISE, octaves: 6 },
    { ...DEFAULT_NOISE, octaves: 9 },
    { ...DEFAULT_NOISE, octaves: 11 },
    { ...DEFAULT_NOISE, seed: 1337 },
    { ...DEFAULT_NOISE, seed: -5, octaves: 7 },
    {
        seed: 42,
        octaves: 5,
        baseFrequency: 3.5,
        baseAmplitude: 7.25,
        lacunarity: 2.17,
        persistence: 0.53,
        globalAmplitude: 22.0,
    },
];

// Deterministic lattice: a fibonacci sphere (unit-magnitude, the real use case)
// plus hand-picked points exercising origin, axes, large magnitudes and the
// simplex branch boundaries.
function fibSphere(n: number): Array<[number, number, number]> {
    const pts: Array<[number, number, number]> = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const y = 1 - (i / (n - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const th = ga * i;
        pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    }
    return pts;
}

const points: Array<[number, number, number]> = [
    ...fibSphere(96),
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.5, 0.5, 0.5],
    [-0.333, 0.666, -0.999],
    [10.5, -20.25, 3.75],
    [123.456, -78.9, 0.001],
    [-1, -1, -1],
    [0.9999999, -0.0001, 0.4],
];

const lines: string[] = [];
lines.push('# cbt_noise reference fixture — f64 values are IEEE-754 hex bits');

paramSets.forEach((p, idx) => {
    lines.push(
        `P ${idx} ${p.seed} ${p.octaves} ${bits(p.baseFrequency)} ${bits(
            p.baseAmplitude
        )} ${bits(p.lacunarity)} ${bits(p.persistence)} ${bits(p.globalAmplitude)}`
    );
});

paramSets.forEach((p, idx) => {
    for (const [x, y, z] of points) {
        const v = fbmNoise(x, y, z, p);
        lines.push(`N ${idx} ${bits(x)} ${bits(y)} ${bits(z)} ${bits(v)}`);
    }
});

for (const seed of [1, 1337, -5, 42]) {
    const perm = buildPerm(seed);
    lines.push(`M ${seed} ${Array.from(perm).join(' ')}`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(
    `wrote ${outPath}: ${paramSets.length} param sets, ${
        paramSets.length * points.length
    } noise samples, 4 perm tables`
);
