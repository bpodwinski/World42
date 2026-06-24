import type { ChunkMeshDataTyped } from '../cdlod/workers/worker_protocol';
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

type Vec3Like = { x: number; y: number; z: number };

/**
 * Compute the per-vertex data (3 vertices) for one leaf triangle into the given
 * output arrays at the supplied element offsets. Shared by the full emitter and
 * the incremental cache so they cannot diverge.
 */
function computeLeafVertexData(
    v0: Vec3Like,
    v1: Vec3Like,
    v2: Vec3Like,
    level: number,
    radius: number,
    noise: NoiseParams | null,
    pos: Float32Array,
    po: number,
    nrm: Float32Array,
    no: number,
    uv: Float32Array,
    uo: number,
    col: Float32Array,
    co: number
): void {
    const lc = LEVEL_COLORS[level % LEVEL_COLORS.length];
    const verts: readonly [Vec3Like, Vec3Like, Vec3Like] = [v0, v1, v2];
    for (let k = 0; k < 3; k++) {
        const vert = verts[k];
        const len = Math.sqrt(vert.x * vert.x + vert.y * vert.y + vert.z * vert.z);
        const invLen = len > 1e-12 ? 1 / len : 0;
        const nx = vert.x * invLen;
        const ny = vert.y * invLen;
        const nz = vert.z * invLen;

        let r = radius;
        if (noise) {
            r += fbmNoise(nx, ny, nz, noise);
        }
        const p = po + k * 3;
        pos[p] = nx * r;
        pos[p + 1] = ny * r;
        pos[p + 2] = nz * r;

        const n = no + k * 3;
        if (noise) {
            const [pnx, pny, pnz] = noiseNormal(nx, ny, nz, radius, noise);
            nrm[n] = pnx;
            nrm[n + 1] = pny;
            nrm[n + 2] = pnz;
        } else {
            nrm[n] = nx;
            nrm[n + 1] = ny;
            nrm[n + 2] = nz;
        }

        const [u, v] = sphericalUV(nx, ny, nz);
        const uoff = uo + k * 2;
        uv[uoff] = u;
        uv[uoff + 1] = v;

        const coff = co + k * 4;
        col[coff] = lc[0];
        col[coff + 1] = lc[1];
        col[coff + 2] = lc[2];
        col[coff + 3] = 1;
    }
}

/**
 * Choose winding for triangle `tri` (3 vertices starting at vertex tri*3) so its
 * front face points outward, reading positions back from the buffer.
 */
function writeTriangleIndices(
    indices: Uint16Array | Uint32Array,
    tri: number,
    positions: Float32Array
): void {
    const base = tri * 3;
    const b0 = base * 3;
    const b1 = b0 + 3;
    const b2 = b0 + 6;
    const ax = positions[b0], ay = positions[b0 + 1], az = positions[b0 + 2];
    const bx = positions[b1], by = positions[b1 + 1], bz = positions[b1 + 2];
    const cx = positions[b2], cy = positions[b2 + 1], cz = positions[b2 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nrx = e1y * e2z - e1z * e2y;
    const nry = e1z * e2x - e1x * e2z;
    const nrz = e1x * e2y - e1y * e2x;
    const outward = nrx * (ax + bx + cx) + nry * (ay + by + cy) + nrz * (az + bz + cz) > 0;
    indices[base] = base;
    if (outward) {
        indices[base + 1] = base + 2;
        indices[base + 2] = base + 1;
    } else {
        indices[base + 1] = base + 1;
        indices[base + 2] = base + 2;
    }
}

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

    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i];
        computeLeafVertexData(
            leaf.v0, leaf.v1, leaf.v2, leaf.level, radius, noise,
            positions, i * 9,
            normals, i * 9,
            uvs, i * 6,
            colors, i * 12
        );
        writeTriangleIndices(indices, i, positions);
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

/**
 * Incremental mesh emitter (Phase A3). Caches each leaf's computed vertex data
 * keyed by its stable slot id, so on a topology change only the slots whose
 * geometry actually changed (the handful created by a split) recompute noise —
 * the dominant rebuild cost. Output is byte-identical to {@link emitMeshFromLeaves}
 * (verified by cbt_emit_incremental.test.ts).
 */
export class CbtEmitCache {
    private cap = 0;
    private pos = new Float32Array(0); // cap*9
    private nrm = new Float32Array(0); // cap*9
    private uv = new Float32Array(0); // cap*6
    private col = new Float32Array(0); // cap*12
    private geom = new Float64Array(0); // cap*9 — cached (v0,v1,v2) to detect slot reuse
    private valid = new Uint8Array(0); // cap
    /** Number of slots recomputed during the last emit (telemetry). */
    recomputed = 0;

    private ensureCap(n: number): void {
        if (n <= this.cap) return;
        let nc = this.cap === 0 ? 256 : this.cap;
        while (nc < n) nc *= 2;
        const pos = new Float32Array(nc * 9); pos.set(this.pos);
        const nrm = new Float32Array(nc * 9); nrm.set(this.nrm);
        const uv = new Float32Array(nc * 6); uv.set(this.uv);
        const col = new Float32Array(nc * 12); col.set(this.col);
        const geom = new Float64Array(nc * 9); geom.set(this.geom);
        const valid = new Uint8Array(nc); valid.set(this.valid);
        this.pos = pos;
        this.nrm = nrm;
        this.uv = uv;
        this.col = col;
        this.geom = geom;
        this.valid = valid;
        this.cap = nc;
    }

    private syncLeaf(leaf: CbtNode, radius: number, noise: NoiseParams | null): void {
        const slot = leaf.id;
        const g = slot * 9;
        const { v0, v1, v2 } = leaf;
        if (
            this.valid[slot] === 1 &&
            this.geom[g] === v0.x && this.geom[g + 1] === v0.y && this.geom[g + 2] === v0.z &&
            this.geom[g + 3] === v1.x && this.geom[g + 4] === v1.y && this.geom[g + 5] === v1.z &&
            this.geom[g + 6] === v2.x && this.geom[g + 7] === v2.y && this.geom[g + 8] === v2.z
        ) {
            return; // cache hit — geometry unchanged
        }
        computeLeafVertexData(
            v0, v1, v2, leaf.level, radius, noise,
            this.pos, slot * 9,
            this.nrm, slot * 9,
            this.uv, slot * 6,
            this.col, slot * 12
        );
        this.geom[g] = v0.x; this.geom[g + 1] = v0.y; this.geom[g + 2] = v0.z;
        this.geom[g + 3] = v1.x; this.geom[g + 4] = v1.y; this.geom[g + 5] = v1.z;
        this.geom[g + 6] = v2.x; this.geom[g + 7] = v2.y; this.geom[g + 8] = v2.z;
        this.valid[slot] = 1;
        this.recomputed++;
    }

    emit(leaves: ReadonlyArray<CbtNode>, radius: number, options: EmitOptions = {}): EmitResult {
        const noise = options.noise === undefined ? DEFAULT_NOISE : options.noise;

        let maxSlot = 0;
        for (const leaf of leaves) if (leaf.id > maxSlot) maxSlot = leaf.id;
        this.ensureCap(maxSlot + 1);

        this.recomputed = 0;
        for (const leaf of leaves) this.syncLeaf(leaf, radius, noise);

        const tv = leaves.length * 3;
        const positions = new Float32Array(tv * 3);
        const normals = new Float32Array(tv * 3);
        const morphDeltas = new Float32Array(tv * 3);
        const uvs = new Float32Array(tv * 2);
        const colors = new Float32Array(tv * 4);
        const indices = tv > 65535 ? new Uint32Array(tv) : new Uint16Array(tv);

        for (let i = 0; i < leaves.length; i++) {
            const slot = leaves[i].id;
            positions.set(this.pos.subarray(slot * 9, slot * 9 + 9), i * 9);
            normals.set(this.nrm.subarray(slot * 9, slot * 9 + 9), i * 9);
            uvs.set(this.uv.subarray(slot * 6, slot * 6 + 6), i * 6);
            colors.set(this.col.subarray(slot * 12, slot * 12 + 12), i * 12);
            writeTriangleIndices(indices, i, positions);
        }

        return { positions, normals, morphDeltas, uvs, indices, colors };
    }
}
