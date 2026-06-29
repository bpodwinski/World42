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
export function buildPerm(seed: number): Uint8Array {
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
    /**
     * Extra "detail" octaves that CONTINUE the fbm cascade past {@link octaves}
     * (same lacunarity/persistence). They are GPU-only and fade in by camera
     * distance so they cost nothing from orbit and add ground-scale relief on
     * approach — the fix for "no detail below ~1.2 km" (the macro cascade's
     * frequency floor). They ADD on top of the macro band (which stays
     * normalized by itself), so the macro surface is unchanged whatever the
     * fade — the CPU collision field still matches the macro topology.
     * Optional: omitted => 0 (no detail, legacy behaviour).
     */
    detailOctaves?: number;
    /**
     * Octave "lifetime" in wavelengths of camera distance — the Nyquist band-limit
     * for the WHOLE cascade (macro + detail), GPU only. An octave of wavelength
     * wl = radiusKm / freq is fully on while the camera is within detailRange * wl
     * and fades out by 2 * detailRange * wl. This both fades detail IN up close and
     * fades fine octaves OUT far away, before they project to sub-pixel — so the
     * height and the analytic normal stop carrying unresolvable high frequencies
     * and the terrain no longer shimmers/aliases as you pull back. LOWER = more
     * aggressive anti-aliasing (smoother sooner); HIGHER = keep fine detail longer
     * (more shimmer risk). Optional: omitted => 60.
     */
    detailRange?: number;
};

/**
 * Canonical terrain noise — the SINGLE source of truth shared by CBT and OCBT:
 *  - the CBT/OCBT GPU shaders bake these via the material header,
 *  - the analytic ground collision (fbmNoise) reproduces the same surface.
 * octaves is capped at 12 (the CBT shader's CBT_MAX_OCTAVES); beyond ~12 the
 * contribution is sub-millimetre at this persistence, so it is imperceptible.
 */
export const DEFAULT_NOISE: NoiseParams = {
    seed: 1,
    octaves: 16,
    baseFrequency: 5.5,
    baseAmplitude: 32,
    lacunarity: 2.07,
    persistence: 0.5,
    // Reduced from 180: craters (cbt_noise.wgsl craterField, depths up to ~18 km) are now the
    // DOMINANT relief; the fbm is the finer inter-crater roughness on top.
    globalAmplitude: 5,
    detailOctaves: 16,
    detailRange: 60,
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

// --- CRATER FIELD (CPU mirror of craterField in cbt_noise.wgsl) ---------------------------
// Real geometric craters = the DOMINANT relief of an airless body. This is the collision/altitude
// twin of the GPU crater field; it MUST match bit-for-bit at crater scale (hash via perm only).
// Height only (no gradient — collision needs height; the GPU computes the shading normal).
const CRATER_CLASSES = 4;
const CRATER_SCALE = 1.0; // keep in sync with CBT_CRATER_SCALE in cbt_noise.wgsl
const CRATER_RANGE = 120.0; // keep in sync with CBT_CRATER_RANGE in cbt_noise.wgsl
const RIM_IRR = 0.15; // keep in sync with CBT_RIM_IRR in cbt_noise.wgsl
const RIM_FREQ = 2.0; // keep in sync with CBT_RIM_FREQ in cbt_noise.wgsl

// [cellSizeKm, crater radius (frac of cell), depthKm, density]. Mirror of craterParams (WGSL).
const CRATER_PARAMS: ReadonlyArray<readonly [number, number, number, number]> = [
    [750, 0.2, 18.0, 0.5],
    [220, 0.2, 7.0, 0.6],
    [70, 0.2, 2.5, 0.7],
    [20, 0.2, 0.9, 0.8],
    [6, 0.2, 0.32, 0.82],
    [2, 0.2, 0.12, 0.85],
];

/** Radial crater profile h(rn) (height only) — mirror of craterProfile (WGSL). `morph` adds the
 *  complex-crater central peak for big classes. `maturity` (0 = fresh, 1 = old/eroded) fills the
 *  floor, wears + widens the rim, and fades the ejecta + central peak. */
function craterProfile(rn: number, morph: number, maturity: number): number {
    const RIM = 0.85,
        RIMH = 0.22,
        RW0 = 0.18,
        FLOOR = -1.0,
        EJH = 0.06,
        EJC = 1.1,
        EJW = 0.9;
    const floorMul = 1 - 0.6 * maturity;
    const rimMul = 1 - 0.7 * maturity;
    const ejMul = 1 - maturity;
    const peakMul = 1 - maturity;
    const RW = RW0 * (1 + 1.6 * maturity);
    let h = 0;
    if (rn < RIM) {
        const u = rn / RIM;
        const s = u * u * (3 - 2 * u);
        h += floorMul * FLOOR * (1 - s);
    }
    const x = (rn - RIM) / RW;
    if (Math.abs(x) < 1) {
        const b = 1 - x * x;
        h += rimMul * RIMH * b * b;
    }
    const xe = (rn - EJC) / EJW;
    if (Math.abs(xe) < 1) {
        const be = 1 - xe * xe;
        h += ejMul * EJH * be * be;
    }
    if (morph > 0 && rn < 0.22) {
        const xp = rn / 0.22;
        const bp = 1 - xp * xp;
        h += morph * peakMul * 0.55 * bp * bp;
    }
    return h;
}

/** Crater height (km) at a unit direction — mirror of craterField (WGSL), height component. */
function craterField(
    x: number,
    y: number,
    z: number,
    perm: Uint8Array,
    radiusKm: number,
    camDistKm: number
): number {
    const pa = (i: number) => perm[i & 255];
    let H = 0;
    for (let k = 0; k < CRATER_CLASSES; k++) {
        const [cell, r0, depth, density] = CRATER_PARAMS[k];
        // Band-limit small classes by camera distance (mirror of the WGSL fade) so the collision
        // surface matches the rendered geometry at every altitude.
        const onKm = CRATER_RANGE * cell;
        const fade = 1 - smoothstep01(onKm, onKm * 2, camDistKm);
        if (fade <= 0) continue;
        const fk = radiusKm / cell;
        const Px = x * fk,
            Py = y * fk,
            Pz = z * fk;
        const Pix = Math.floor(Px),
            Piy = Math.floor(Py),
            Piz = Math.floor(Pz);
        // Irregular-rim warp: ONE simplex per class (mirror of WGSL), shared by the class's craters.
        const irr = 1 + RIM_IRR * simplex3(perm, Px * RIM_FREQ, Py * RIM_FREQ, Pz * RIM_FREQ);
        let h = 0;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const cix = Pix + dx,
                        ciy = Piy + dy,
                        ciz = Piz + dz;
                    const ix = cix & 255,
                        iy = ciy & 255,
                        iz = ciz & 255;
                    const q0 = pa(ix + pa(iy + pa(iz)));
                    if (q0 / 256 >= density) continue;
                    const q1 = pa(ix + 1 + pa(iy + pa(iz)));
                    const q2 = pa(ix + pa(iy + 1 + pa(iz)));
                    // Age hash (mirror of WGSL) -> maturity 0..1: fresh craters stay sharp.
                    const q3 = pa(ix + pa(iy + pa(iz + 1)));
                    const maturity = q3 / 256;
                    const r0e = r0 * (0.8 + 0.4 * (q2 / 256));
                    const depe = depth * CRATER_SCALE * (0.6 + 0.8 * (q1 / 256));
                    const qx = Px - (cix + 0.15 + 0.7 * (q0 / 256));
                    const qy = Py - (ciy + 0.15 + 0.7 * (q1 / 256));
                    const qz = Pz - (ciz + 0.15 + 0.7 * (q2 / 256));
                    const dist = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1e-9;
                    const rEff = r0e * irr;
                    const rn = dist / rEff;
                    if (rn >= 2) continue;
                    const morph = k <= 2 ? 1 : 0;
                    h += depe * craterProfile(rn, morph, maturity);
                }
            }
        }
        H += h * fade;
    }
    return H;
}

/** WGSL smoothstep: 0 below e0, 1 above e1, smooth cubic in between. */
function smoothstep01(e0: number, e1: number, x: number): number {
    if (e0 === e1) return x < e0 ? 0 : 1;
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/**
 * Ground height as the OCBT shader ACTUALLY renders it near the camera: the macro
 * fbm PLUS the continued-detail octaves, each band-limited by camera distance with
 * the SAME per-octave fade as cbtFbm_d_at (cbt_noise.wgsl). Use this for collision /
 * altitude so the camera sits on the VISIBLE surface (macro + relief), not the
 * macro-only field — otherwise it floats over detail troughs / clips detail bumps.
 *
 * fbmNoise stays the macro-only canonical field (golden + Rust parity + far LOD).
 * Octave caps mirror the shader (CBT_MAX_OCTAVES = CBT_MAX_DETAIL = 12) so the CPU
 * floor equals the GPU vertex height. camDistKm/radiusKm are in the shader's units
 * (sim units = km here): camDistKm is the camera's distance to that ground point.
 */
export function fbmGroundHeight(
    x: number, y: number, z: number,
    params: NoiseParams,
    camDistKm: number,
    radiusKm: number
): number {
    const perm = getPerm(params.seed);
    const range = params.detailRange ?? 60;
    let sum = 0;
    let maxMacro = 0;
    let freq = params.baseFrequency;
    let amp = params.baseAmplitude;

    // Macro octaves (shader caps at CBT_MAX_OCTAVES = 12), band-limited by distance.
    const macroN = Math.min(params.octaves, 12);
    for (let i = 0; i < macroN; i++) {
        const onKm = range * (radiusKm / freq);
        const fade = 1 - smoothstep01(onKm, onKm * 2, camDistKm);
        sum += simplex3(perm, x * freq, y * freq, z * freq) * amp * fade;
        maxMacro += amp; // unfaded -> normalization fixed, full macro at the surface
        freq *= params.lacunarity;
        amp *= params.persistence;
    }
    if (maxMacro <= 1e-12) return 0;

    // Continued-detail octaves (shader caps at CBT_MAX_DETAIL = 12).
    const detailN = Math.min(params.detailOctaves ?? 0, 12);
    for (let j = 0; j < detailN; j++) {
        const onKm = range * (radiusKm / freq);
        const fade = 1 - smoothstep01(onKm, onKm * 2, camDistKm);
        if (fade > 0) sum += simplex3(perm, x * freq, y * freq, z * freq) * amp * fade;
        freq *= params.lacunarity;
        amp *= params.persistence;
    }

    // Craters are the dominant relief: added (in km) on top of the reduced fbm. Big classes never
    // fade; small classes band-limit by camDistKm (matching the GPU). MUST match the GPU df64 eval
    // (cbtFbm_d_at_df64) so the camera collides with the rendered crater floors/rims.
    return (sum / maxMacro) * params.globalAmplitude + craterField(x, y, z, perm, radiusKm, camDistKm);
}
