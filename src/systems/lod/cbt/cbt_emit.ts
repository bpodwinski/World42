import type { ChunkMeshDataTyped } from '../workers/worker_protocol';
import type { CbtNode } from './cbt_state';
import { fbmNoise, type NoiseParams, DEFAULT_NOISE } from './cbt_noise';

/** Default subdivisions per leaf edge. N=8 → 36 verts, 64 tris per leaf. */
const DEFAULT_SUBDIV = 8;

/** Finite-difference step for surface gradient normals (in unit-sphere space). */
const GRAD_EPS = 5e-3;

function sphericalUV(nx: number, ny: number, nz: number): [number, number] {
    const u = 0.5 + Math.atan2(nz, nx) / (2 * Math.PI);
    const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI;
    return [u, v];
}

/**
 * Build two tangent vectors for a point on the unit sphere.
 * Returns [tx, ty, tz, bx, by, bz].
 */
function sphereTangents(nx: number, ny: number, nz: number): [number, number, number, number, number, number] {
    // Pick an axis not parallel to n
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(ny) > 0.9) { ax = 1; ay = 0; az = 0; }

    // tangent = normalize(cross(n, arbitrary))
    let tx = ny * az - nz * ay;
    let ty = nz * ax - nx * az;
    let tz = nx * ay - ny * ax;
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const tInv = tLen > 1e-12 ? 1 / tLen : 0;
    tx *= tInv; ty *= tInv; tz *= tInv;

    // bitangent = cross(n, tangent)
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    return [tx, ty, tz, bx, by, bz];
}

/**
 * Compute a perturbed normal from the noise surface gradient.
 * Uses central finite differences along two sphere-tangent directions.
 */
function noiseNormal(
    nx: number, ny: number, nz: number,
    radius: number,
    noise: NoiseParams
): [number, number, number] {
    const [tx, ty, tz, bx, by, bz] = sphereTangents(nx, ny, nz);
    const eps = GRAD_EPS;

    // Sample noise at offset positions along tangent and bitangent
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

    // Scale gradient by 1/radius so perturbation is proportional to surface
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
    subdiv?: number;
    noise?: NoiseParams | null;
};

/**
 * Emit a single mesh from all CBT leaf triangles.
 *
 * Each leaf is subdivided into a barycentric grid of `subdiv²` sub-triangles.
 * Vertices are projected onto the sphere and displaced by noise.
 * Normals are computed via surface gradient (noise finite differences).
 */
export function emitMeshFromLeaves(
    leaves: ReadonlyArray<CbtNode>,
    radius: number,
    options: EmitOptions = {}
): ChunkMeshDataTyped {
    const N = Math.max(1, options.subdiv ?? DEFAULT_SUBDIV);
    const noise = options.noise === undefined ? DEFAULT_NOISE : options.noise;

    const vertsPerLeaf = ((N + 1) * (N + 2)) / 2;
    const trisPerLeaf = N * N;

    const totalVertices = leaves.length * vertsPerLeaf;
    const totalIndices = leaves.length * trisPerLeaf * 3;

    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    const morphDeltas = new Float32Array(totalVertices * 3);
    const uvs = new Float32Array(totalVertices * 2);
    const indices =
        totalVertices > 65535
            ? new Uint32Array(totalIndices)
            : new Uint16Array(totalIndices);

    let vOff = 0;
    let uvOff = 0;
    let iOff = 0;

    for (const leaf of leaves) {
        const baseVertex = vOff / 3;
        const v0x = leaf.v0.x, v0y = leaf.v0.y, v0z = leaf.v0.z;
        const v1x = leaf.v1.x, v1y = leaf.v1.y, v1z = leaf.v1.z;
        const v2x = leaf.v2.x, v2y = leaf.v2.y, v2z = leaf.v2.z;

        const rowStart: number[] = new Array(N + 2);
        let localIdx = 0;

        // --- Vertices ---
        for (let i = 0; i <= N; i++) {
            rowStart[i] = localIdx;
            const cols = N - i;
            for (let j = 0; j <= cols; j++) {
                const a = i / N;
                const b = j / N;
                const c = 1 - a - b;

                const px = v0x * c + v1x * a + v2x * b;
                const py = v0y * c + v1y * a + v2y * b;
                const pz = v0z * c + v1z * a + v2z * b;

                // Project onto unit sphere
                const len = Math.sqrt(px * px + py * py + pz * pz);
                const invLen = len > 1e-12 ? 1 / len : 0;
                const nx = px * invLen;
                const ny = py * invLen;
                const nz = pz * invLen;

                // Noise displacement along radial
                let r = radius;
                if (noise) {
                    r += fbmNoise(nx, ny, nz, noise);
                }

                positions[vOff] = nx * r;
                positions[vOff + 1] = ny * r;
                positions[vOff + 2] = nz * r;

                // Surface gradient normal (perturbed by noise)
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

                vOff += 3;
                uvOff += 2;
                localIdx++;
            }
        }

        // --- Indices ---
        for (let i = 0; i < N; i++) {
            const cols = N - i;
            for (let j = 0; j < cols; j++) {
                const ia = baseVertex + rowStart[i] + j;
                const ib = baseVertex + rowStart[i] + j + 1;
                const id = baseVertex + rowStart[i + 1] + j;

                indices[iOff++] = ia;
                indices[iOff++] = ib;
                indices[iOff++] = id;

                if (j < cols - 1) {
                    const ie = baseVertex + rowStart[i + 1] + j + 1;
                    indices[iOff++] = ib;
                    indices[iOff++] = ie;
                    indices[iOff++] = id;
                }
            }
        }
    }

    return {
        positions,
        normals,
        morphDeltas,
        uvs,
        indices,
    };
}
