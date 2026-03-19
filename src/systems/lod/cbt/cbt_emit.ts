import type { ChunkMeshDataTyped } from '../workers/worker_protocol';
import type { CbtNode } from './cbt_state';
import { fbmNoise, type NoiseParams, DEFAULT_NOISE } from './cbt_noise';

/** Finite-difference step for surface gradient normals (in unit-sphere space). */
const GRAD_EPS = 5e-3;

function sphericalUV(nx: number, ny: number, nz: number): [number, number] {
    const u = 0.5 + Math.atan2(nz, nx) / (2 * Math.PI);
    const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI;
    return [u, v];
}

function sphereTangents(nx: number, ny: number, nz: number): [number, number, number, number, number, number] {
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(ny) > 0.9) { ax = 1; ay = 0; az = 0; }

    let tx = ny * az - nz * ay;
    let ty = nz * ax - nx * az;
    let tz = nx * ay - ny * ax;
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const tInv = tLen > 1e-12 ? 1 / tLen : 0;
    tx *= tInv; ty *= tInv; tz *= tInv;

    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    return [tx, ty, tz, bx, by, bz];
}

function noiseNormal(
    nx: number, ny: number, nz: number,
    radius: number,
    noise: NoiseParams
): [number, number, number] {
    const [tx, ty, tz, bx, by, bz] = sphereTangents(nx, ny, nz);
    const eps = GRAD_EPS;

    const sampleHeight = (dx: number, dy: number, dz: number) => {
        const sx = nx + dx, sy = ny + dy, sz = nz + dz;
        const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
        const inv = len > 1e-12 ? 1 / len : 0;
        return fbmNoise(sx * inv, sy * inv, sz * inv, noise);
    };

    const dhdt = (sampleHeight(tx * eps, ty * eps, tz * eps)
               -  sampleHeight(-tx * eps, -ty * eps, -tz * eps)) / (2 * eps);
    const dhdb = (sampleHeight(bx * eps, by * eps, bz * eps)
               -  sampleHeight(-bx * eps, -by * eps, -bz * eps)) / (2 * eps);

    const scale = 1 / radius;
    let pnx = nx - dhdt * scale * tx - dhdb * scale * bx;
    let pny = ny - dhdt * scale * ty - dhdb * scale * by;
    let pnz = nz - dhdt * scale * tz - dhdb * scale * bz;

    const len = Math.sqrt(pnx * pnx + pny * pny + pnz * pnz);
    const inv = len > 1e-12 ? 1 / len : 0;
    pnx *= inv; pny *= inv; pnz *= inv;

    return [pnx, pny, pnz];
}

export type EmitOptions = {
    noise?: NoiseParams | null;
};

export type EmitResult = ChunkMeshDataTyped & {
    colors: Float32Array;
};

/** LOD level color palette (up to 16 levels). */
const LEVEL_COLORS: ReadonlyArray<readonly [number, number, number]> = [
    [0.15, 0.15, 0.80], // 0  dark blue
    [0.10, 0.50, 0.90], // 1  blue
    [0.10, 0.75, 0.75], // 2  cyan
    [0.10, 0.80, 0.30], // 3  green
    [0.50, 0.85, 0.10], // 4  lime
    [0.90, 0.90, 0.10], // 5  yellow
    [1.00, 0.65, 0.05], // 6  orange
    [1.00, 0.35, 0.05], // 7  red-orange
    [0.90, 0.10, 0.10], // 8  red
    [0.80, 0.10, 0.50], // 9  magenta
    [0.60, 0.10, 0.70], // 10 purple
    [0.40, 0.10, 0.80], // 11 violet
    [1.00, 1.00, 1.00], // 12 white
    [0.70, 0.70, 0.70], // 13 light gray
    [0.40, 0.40, 0.40], // 14 dark gray
    [1.00, 0.00, 1.00], // 15 pink
];

/**
 * Emit a single mesh from all CBT leaf triangles.
 *
 * True CBT: each leaf = 1 triangle (3 vertices).
 * Noise displacement + surface gradient normals applied per vertex.
 * No internal subdivision — the CBT depth IS the mesh resolution.
 */
export function emitMeshFromLeaves(
    leaves: ReadonlyArray<CbtNode>,
    radius: number,
    options: EmitOptions = {}
): EmitResult {
    const noise = options.noise === undefined ? DEFAULT_NOISE : options.noise;

    const totalVertices = leaves.length * 3;
    const totalIndices = leaves.length * 3;

    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    const morphDeltas = new Float32Array(totalVertices * 3);
    const uvs = new Float32Array(totalVertices * 2);
    const colors = new Float32Array(totalVertices * 4);
    const indices =
        totalVertices > 65535
            ? new Uint32Array(totalIndices)
            : new Uint16Array(totalIndices);

    let vOff = 0;
    let uvOff = 0;
    let cOff = 0;
    let idx = 0;

    for (const leaf of leaves) {
        const lc = LEVEL_COLORS[leaf.level % LEVEL_COLORS.length];
        const verts = [leaf.v0, leaf.v1, leaf.v2] as const;

        for (const vert of verts) {
            // Project onto unit sphere
            const len = Math.sqrt(vert.x * vert.x + vert.y * vert.y + vert.z * vert.z);
            const invLen = len > 1e-12 ? 1 / len : 0;
            const nx = vert.x * invLen;
            const ny = vert.y * invLen;
            const nz = vert.z * invLen;

            // Noise displacement along radial
            let r = radius;
            if (noise) {
                r += fbmNoise(nx, ny, nz, noise);
            }

            positions[vOff] = nx * r;
            positions[vOff + 1] = ny * r;
            positions[vOff + 2] = nz * r;

            // Surface gradient normal
            if (noise) {
                const [pnx, pny, pnz] = noiseNormal(nx, ny, nz, radius, noise);
                normals[vOff] = pnx;
                normals[vOff + 1] = pny;
                normals[vOff + 2] = pnz;
            } else {
                normals[vOff] = nx;
                normals[vOff + 1] = ny;
                normals[vOff + 2] = nz;
            }

            const [u, v] = sphericalUV(nx, ny, nz);
            uvs[uvOff] = u;
            uvs[uvOff + 1] = v;

            colors[cOff] = lc[0];
            colors[cOff + 1] = lc[1];
            colors[cOff + 2] = lc[2];
            colors[cOff + 3] = 1;

            vOff += 3;
            uvOff += 2;
            cOff += 4;
            idx++;
        }

        // Emit indices with flipped winding (CW for BabylonJS front-face)
        const base = idx - 3;
        indices[base] = base;
        indices[base + 1] = base + 2;
        indices[base + 2] = base + 1;
    }

    return {
        positions,
        normals,
        morphDeltas,
        uvs,
        indices,
        colors,
    };
}
