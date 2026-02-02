/**
 * This worker is designed to compute the mesh data for a terrain chunk
 * It offloads heavy mesh computation to a separate thread so that the main application remains responsive
 * The worker calculates positions, indices, normals, and UV coordinates required for the mesh
 * It uses a minimal implementation of the Vector3 class for essential vector operations
 * The parameters (UV bounds, grid resolution, sphere radius, and cube face) are used to generate the mesh data and post the result back to the main thread
 */

/**
 * Minimal implementation of a 3D vector
 */
class Vector3 {
    constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }

    static Distance(v1, v2) {
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        const dz = v2.z - v1.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    normalize() {
        const len = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
        if (len === 0) return new Vector3(0, 0, 0);
        return new Vector3(this.x / len, this.y / len, this.z / len);
    }

    scale(s) { return new Vector3(this.x * s, this.y * s, this.z * s); }

    cross(v) {
        return new Vector3(
            this.y * v.z - this.z * v.y,
            this.z * v.x - this.x * v.z,
            this.x * v.y - this.y * v.x
        );
    }

    add(v) { return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z); }
}

function fractalNoise(
    noise,
    x,
    y,
    z,
    octaves = 4,
    baseFrequency = 1,
    baseAmplitude = 1,
    lacunarity = 2.0,
    persistence = 0.5
) {
    let sum = 0;
    let maxPossible = 0;
    let frequency = baseFrequency;
    let amplitude = baseAmplitude;

    for (let i = 0; i < octaves; i++) {
        const value = noise.noise(x * frequency, y * frequency, z * frequency);
        sum += value * amplitude;
        maxPossible += amplitude;
        frequency *= lacunarity;
        amplitude *= persistence;
    }

    return sum / maxPossible;
}

class SimplexNoise {
    constructor(seed = 0) {
        this.p = new Uint8Array(512);
        this.perm = new Uint8Array(512);
        for (let i = 0; i < 256; i++) this.p[i] = i;

        let rng = seedrandom(seed);
        for (let i = 255; i > 0; i--) {
            const n = Math.floor(rng() * (i + 1));
            [this.p[i], this.p[n]] = [this.p[n], this.p[i]];
        }
        for (let i = 0; i < 512; i++) this.perm[i] = this.p[i & 255];
    }

    dot(g, x, y, z) { return g[0] * x + g[1] * y + g[2] * z; }

    noise(xin, yin, zin) {
        const grad3 = [
            [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
            [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
            [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
        ];

        const F3 = 1 / 3;
        const G3 = 1 / 6;

        let n0, n1, n2, n3;
        let s = (xin + yin + zin) * F3;
        let i = Math.floor(xin + s);
        let j = Math.floor(yin + s);
        let k = Math.floor(zin + s);
        let t = (i + j + k) * G3;
        let X0 = i - t;
        let Y0 = j - t;
        let Z0 = k - t;
        let x0 = xin - X0;
        let y0 = yin - Y0;
        let z0 = zin - Z0;

        let i1, j1, k1;
        let i2, j2, k2;
        if (x0 >= y0) {
            if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
            else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
            else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
        } else {
            if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
            else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
            else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        }

        let x1 = x0 - i1 + G3;
        let y1 = y0 - j1 + G3;
        let z1 = z0 - k1 + G3;
        let x2 = x0 - i2 + 2 * G3;
        let y2 = y0 - j2 + 2 * G3;
        let z2 = z0 - k2 + 2 * G3;
        let x3 = x0 - 1 + 3 * G3;
        let y3 = y0 - 1 + 3 * G3;
        let z3 = z0 - 1 + 3 * G3;

        i &= 255; j &= 255; k &= 255;
        const gi0 = this.perm[i + this.perm[j + this.perm[k]]] % 12;
        const gi1 = this.perm[i + i1 + this.perm[j + j1 + this.perm[k + k1]]] % 12;
        const gi2 = this.perm[i + i2 + this.perm[j + j2 + this.perm[k + k2]]] % 12;
        const gi3 = this.perm[i + 1 + this.perm[j + 1 + this.perm[k + 1]]] % 12;

        const t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
        n0 = t0 < 0 ? 0 : t0 * t0 * (t0 * t0) * this.dot(grad3[gi0], x0, y0, z0);

        const t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
        n1 = t1 < 0 ? 0 : t1 * t1 * (t1 * t1) * this.dot(grad3[gi1], x1, y1, z1);

        const t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
        n2 = t2 < 0 ? 0 : t2 * t2 * (t2 * t2) * this.dot(grad3[gi2], x2, y2, z2);

        const t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
        n3 = t3 < 0 ? 0 : t3 * t3 * (t3 * t3) * this.dot(grad3[gi3], x3, y3, z3);

        return 32 * (n0 + n1 + n2 + n3);
    }
}

function seedrandom(seed) {
    let x = Math.sin(seed) * 10000;
    return () => {
        x = Math.sin(x) * 10000;
        return x - Math.floor(x);
    };
}

function computeChunkMeshData(bounds, resolution, radius, face, noise) {
    const res = resolution;

    const vertCount = (res + 1) * (res + 1);
    const indexCount = res * res * 6;

    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const useUint32 = vertCount > 65535;
    const indices = useUint32 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    let indexWrite = 0;

    const octaves = 8;
    const baseFrequency = 1.0;
    const baseAmplitude = 4.0;
    const lacunarity = 2.5;
    const persistence = 0.5;
    const globalTerrainAmplitude = 100.0;

    const angleUMin = Math.atan(bounds.uMin);
    const angleUMax = Math.atan(bounds.uMax);
    const angleVMin = Math.atan(bounds.vMin);
    const angleVMax = Math.atan(bounds.vMax);

    const verts = [];

    function computePatchCenterLocal(bounds, radius, face) {
        const aUMin = Math.atan(bounds.uMin);
        const aUMax = Math.atan(bounds.uMax);
        const aVMin = Math.atan(bounds.vMin);
        const aVMax = Math.atan(bounds.vMax);

        const aUCenter = (aUMin + aUMax) * 0.5;
        const aVCenter = (aVMin + aVMax) * 0.5;

        const uCenter = Math.tan(aUCenter);
        const vCenter = Math.tan(aVCenter);

        const posCube = mapUVtoCube(uCenter, vCenter, face);
        return posCube.normalize().scale(radius);
    }

    const centerLocal = computePatchCenterLocal(bounds, radius, face);
    const dir = centerLocal.normalize();

    let minPlanetRadius = Infinity;
    let maxPlanetRadius = -Infinity;

    for (let i = 0; i <= res; i++) {
        const angleV = angleVMin + (angleVMax - angleVMin) * (i / res);

        for (let j = 0; j <= res; j++) {
            const angleU = angleUMin + (angleUMax - angleUMin) * (j / res);

            const posCube = mapUVtoCube(Math.tan(angleU), Math.tan(angleV), face);
            const unit = posCube.normalize();

            const fractalValue = fractalNoise(
                noise,
                unit.x, unit.y, unit.z,
                octaves,
                baseFrequency,
                baseAmplitude,
                lacunarity,
                persistence
            );

            const elevation = fractalValue * globalTerrainAmplitude;
            const pr = radius + elevation;

            if (pr < minPlanetRadius) minPlanetRadius = pr;
            if (pr > maxPlanetRadius) maxPlanetRadius = pr;

            const posSphere = unit.scale(pr);
            verts.push(posSphere);

            const vIndex = i * (res + 1) + j;
            const pOff = vIndex * 3;
            const uvOff = vIndex * 2;

            positions[pOff + 0] = posSphere.x;
            positions[pOff + 1] = posSphere.y;
            positions[pOff + 2] = posSphere.z;

            normals[pOff + 0] = posSphere.x / pr;
            normals[pOff + 1] = posSphere.y / pr;
            normals[pOff + 2] = posSphere.z / pr;

            const u = (Math.atan2(posSphere.x, posSphere.z) + Math.PI) / (2 * Math.PI);
            const v = Math.acos(posSphere.y / pr) / Math.PI;
            uvs[uvOff + 0] = u;
            uvs[uvOff + 1] = v;
        }
    }

    const centerR = 0.5 * (minPlanetRadius + maxPlanetRadius);
    const centerLocal2 = dir.scale(centerR);

    let maxDist2b = 0;
    for (const v of verts) {
        const dx = v.x - centerLocal2.x;
        const dy = v.y - centerLocal2.y;
        const dz = v.z - centerLocal2.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > maxDist2b) maxDist2b = d2;
    }
    const boundingRadius = Math.sqrt(maxDist2b);

    const normalAccum = new Array(verts.length).fill(null).map(() => new Vector3(0, 0, 0));
    const normalCount = new Array(verts.length).fill(0);

    for (let i = 0; i < res; i++) {
        for (let j = 0; j < res; j++) {
            const index0 = i * (res + 1) + j;
            const index1 = index0 + 1;
            const index2 = (i + 1) * (res + 1) + j;
            const index3 = index2 + 1;

            const v0 = verts[index0];
            const v1 = verts[index1];
            const v2 = verts[index2];
            const v3 = verts[index3];

            const d1 = Vector3.Distance(v0, v3);
            const d2 = Vector3.Distance(v1, v2);

            let tri1Indices, tri2Indices;
            if (d1 < d2) {
                tri1Indices = [index0, index3, index1];
                tri2Indices = [index0, index2, index3];

                indices[indexWrite++] = index0;
                indices[indexWrite++] = index3;
                indices[indexWrite++] = index1;
                indices[indexWrite++] = index0;
                indices[indexWrite++] = index2;
                indices[indexWrite++] = index3;
            } else {
                tri1Indices = [index0, index2, index1];
                tri2Indices = [index1, index2, index3];

                indices[indexWrite++] = index0;
                indices[indexWrite++] = index2;
                indices[indexWrite++] = index1;
                indices[indexWrite++] = index1;
                indices[indexWrite++] = index2;
                indices[indexWrite++] = index3;
            }

            const tri1Normal = computeTriangleNormal(v0, verts[tri1Indices[1]], verts[tri1Indices[2]]);
            const tri2Normal = computeTriangleNormal(v0, verts[tri2Indices[1]], verts[tri2Indices[2]]);

            tri1Indices.forEach((idx) => { normalAccum[idx] = normalAccum[idx].add(tri1Normal); normalCount[idx]++; });
            tri2Indices.forEach((idx) => { normalAccum[idx] = normalAccum[idx].add(tri2Normal); normalCount[idx]++; });
        }
    }

    for (let i = 0; i < verts.length; i++) {
        if (normalCount[i] > 0) {
            const avgNormal = normalAccum[i].scale(1 / normalCount[i]).normalize();
            const idx = i * 3;
            normals[idx + 0] = avgNormal.x;
            normals[idx + 1] = avgNormal.y;
            normals[idx + 2] = avgNormal.z;
        }
    }

    return {
        positions,
        indices,
        normals,
        uvs,
        boundsInfo: {
            centerLocal: [centerLocal2.x, centerLocal2.y, centerLocal2.z],
            boundingRadius,
            minPlanetRadius,
            maxPlanetRadius
        }
    };
}

function computeTriangleNormal(v0, v1, v2) {
    const edge1 = new Vector3(v1.x - v0.x, v1.y - v0.y, v1.z - v0.z);
    const edge2 = new Vector3(v2.x - v0.x, v2.y - v0.y, v2.z - v0.z);
    return edge2.cross(edge1).normalize();
}

function mapUVtoCube(u, v, face) {
    switch (face) {
        case "front": return new Vector3(u, v, 1);
        case "back": return new Vector3(-u, v, -1);
        case "left": return new Vector3(-1, v, u);
        case "right": return new Vector3(1, v, -u);
        case "top": return new Vector3(u, 1, -v);
        case "bottom": return new Vector3(u, -1, v);
        default: return new Vector3(u, v, 1);
    }
}

/* ===========================
   Phase 1: Stable worker protocol
   =========================== */

const PROTOCOL = "mesh-kernel/1";

let currentJobId = null;
let cancelCurrent = false;

function postReady(id) {
    self.postMessage({
        protocol: PROTOCOL,
        kind: "ready",
        id,
        payload: { impl: "js", meshFormats: ["arrays", "typed"] }
    });
}

function postError(id, code, message) {
    self.postMessage({
        protocol: PROTOCOL,
        kind: "error",
        id,
        payload: { code, message }
    });
}

function transferMeshDataTyped(id, meshData, stats) {
    self.postMessage(
        {
            protocol: PROTOCOL,
            kind: "chunk_result",
            id,
            payload: { meshData, stats }
        },
        [
            meshData.positions.buffer,
            meshData.normals.buffer,
            meshData.uvs.buffer,
            meshData.indices.buffer
        ]
    );
}

function postMeshDataArrays(id, meshData, stats) {
    self.postMessage({
        protocol: PROTOCOL,
        kind: "chunk_result",
        id,
        payload: { meshData, stats }
    });
}

function toArrays(meshDataTyped) {
    return {
        ...meshDataTyped,
        positions: Array.from(meshDataTyped.positions),
        normals: Array.from(meshDataTyped.normals),
        uvs: Array.from(meshDataTyped.uvs),
        indices: Array.from(meshDataTyped.indices),
    };
}

self.onmessage = (event) => {
    const msg = event.data;

    // Legacy (pre-protocol) support:
    // expects { bounds, resolution, radius, face, seed } and returns typed arrays + transfer.
    if (!msg || typeof msg !== "object" || msg.protocol !== PROTOCOL) {
        const start = performance.now();
        const { bounds, resolution, radius, face, seed } = msg;
        const noiseInstance = new SimplexNoise(seed || 1);

        const meshData = computeChunkMeshData(bounds, resolution, radius, face, noiseInstance);

        self.postMessage(meshData, [
            meshData.positions.buffer,
            meshData.normals.buffer,
            meshData.uvs.buffer,
            meshData.indices.buffer
        ]);

        console.log("Chunk created at: " + (performance.now() - start) + "ms");
        return;
    }

    // Protocol messages
    if (msg.kind === "init") {
        postReady(msg.id);
        return;
    }

    if (msg.kind === "cancel") {
        const cancelId = msg.payload?.cancelId;
        if (cancelId && currentJobId === cancelId) cancelCurrent = true;
        return;
    }

    if (msg.kind !== "build_chunk") {
        postError(msg.id ?? "unknown", "bad_request", "Unknown message kind");
        return;
    }

    // build_chunk
    const start = performance.now();
    const id = msg.id;

    try {
        currentJobId = id;
        cancelCurrent = false;

        const p = msg.payload;

        const seed = (p?.noise?.seed ?? 1) | 0;
        const noiseInstance = new SimplexNoise(seed);

        const meshDataTyped = computeChunkMeshData(
            p.bounds,
            p.resolution,
            p.radius,
            p.face,
            noiseInstance
        );

        if (cancelCurrent) {
            postError(id, "cancelled", "Job cancelled");
            return;
        }

        const stats = {
            ms: performance.now() - start,
            vertexCount: meshDataTyped.positions.length / 3,
            indexCount: meshDataTyped.indices.length
        };

        const meshFormat = p.meshFormat || "typed";

        if (meshFormat === "arrays") {
            const meshDataArrays = toArrays(meshDataTyped);
            postMeshDataArrays(id, meshDataArrays, stats);
        } else {
            transferMeshDataTyped(id, meshDataTyped, stats);
        }
    } catch (e) {
        postError(id, "exception", String(e?.message || e));
    } finally {
        currentJobId = null;
        cancelCurrent = false;
    }
};
