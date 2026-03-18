import type { ChunkMeshDataTyped } from '../workers/worker_protocol';
import type { CbtNode } from './cbt_state';

/**
 * Default number of edge subdivisions per leaf triangle.
 * With N=8 each leaf becomes 64 sub-triangles (45 vertices before indexing).
 */
const DEFAULT_SUBDIV = 8;

/** Backside culling threshold — leaves facing away beyond this are skipped. */
const BACKSIDE_THRESHOLD = -0.3;

function sphericalUV(nx: number, ny: number, nz: number): [number, number] {
    const u = 0.5 + Math.atan2(nz, nx) / (2 * Math.PI);
    const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI;
    return [u, v];
}

/**
 * Emit a mesh from CBT leaf triangles, subdividing each leaf into a grid
 * of sub-triangles with all vertices projected onto the sphere surface.
 *
 * @param cameraLocalPos  Camera position in planet-local space (origin = planet center).
 *                        When provided, leaves on the far hemisphere are culled.
 */
export function emitMeshFromLeaves(
    leaves: ReadonlyArray<CbtNode>,
    radius: number,
    cameraLocalPos: { x: number; y: number; z: number } | null = null,
    subdiv: number = DEFAULT_SUBDIV
): ChunkMeshDataTyped {
    const N = Math.max(1, subdiv);
    const vertsPerLeaf = ((N + 1) * (N + 2)) / 2;
    const trisPerLeaf = N * N;

    // --- Backside cull: filter leaves facing away from camera ---
    let visibleLeaves: ReadonlyArray<CbtNode>;
    if (cameraLocalPos) {
        const camLen = Math.sqrt(
            cameraLocalPos.x * cameraLocalPos.x +
            cameraLocalPos.y * cameraLocalPos.y +
            cameraLocalPos.z * cameraLocalPos.z
        );
        const invCamLen = camLen > 1e-12 ? 1 / camLen : 0;
        const cdx = cameraLocalPos.x * invCamLen;
        const cdy = cameraLocalPos.y * invCamLen;
        const cdz = cameraLocalPos.z * invCamLen;

        visibleLeaves = leaves.filter((leaf) => {
            // Centroid of the leaf (before sphere projection)
            const cx = (leaf.v0.x + leaf.v1.x + leaf.v2.x) / 3;
            const cy = (leaf.v0.y + leaf.v1.y + leaf.v2.y) / 3;
            const cz = (leaf.v0.z + leaf.v1.z + leaf.v2.z) / 3;
            const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
            const invLen = len > 1e-12 ? 1 / len : 0;
            // dot(leafNormal, cameraDir) — positive means camera-facing
            return (cx * invLen * cdx + cy * invLen * cdy + cz * invLen * cdz) > BACKSIDE_THRESHOLD;
        });
    } else {
        visibleLeaves = leaves;
    }

    const totalVertices = visibleLeaves.length * vertsPerLeaf;
    const totalIndices = visibleLeaves.length * trisPerLeaf * 3;

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

    for (const leaf of visibleLeaves) {
        const baseVertex = vOff / 3;
        const v0x = leaf.v0.x, v0y = leaf.v0.y, v0z = leaf.v0.z;
        const v1x = leaf.v1.x, v1y = leaf.v1.y, v1z = leaf.v1.z;
        const v2x = leaf.v2.x, v2y = leaf.v2.y, v2z = leaf.v2.z;

        const rowStart: number[] = new Array(N + 2);
        let localIdx = 0;

        for (let i = 0; i <= N; i++) {
            rowStart[i] = localIdx;
            const cols = N - i;
            for (let j = 0; j <= cols; j++) {
                const a = i / N;
                const b = j / N;
                const c = 1 - a - b;

                let px = v0x * c + v1x * a + v2x * b;
                let py = v0y * c + v1y * a + v2y * b;
                let pz = v0z * c + v1z * a + v2z * b;

                const len = Math.sqrt(px * px + py * py + pz * pz);
                const invLen = len > 1e-12 ? radius / len : 0;
                px *= invLen;
                py *= invLen;
                pz *= invLen;

                const nx = px / radius;
                const ny = py / radius;
                const nz = pz / radius;

                positions[vOff] = px;
                positions[vOff + 1] = py;
                positions[vOff + 2] = pz;

                normals[vOff] = nx;
                normals[vOff + 1] = ny;
                normals[vOff + 2] = nz;

                const [u, v] = sphericalUV(nx, ny, nz);
                uvs[uvOff] = u;
                uvs[uvOff + 1] = v;

                vOff += 3;
                uvOff += 2;
                localIdx++;
            }
        }

        // Emit triangles — CW winding for BabylonJS front-face (outward)
        for (let i = 0; i < N; i++) {
            const cols = N - i;
            for (let j = 0; j < cols; j++) {
                const a = baseVertex + rowStart[i] + j;
                const b = baseVertex + rowStart[i] + j + 1;
                const d = baseVertex + rowStart[i + 1] + j;

                indices[iOff++] = a;
                indices[iOff++] = b;
                indices[iOff++] = d;

                if (j < cols - 1) {
                    const e = baseVertex + rowStart[i + 1] + j + 1;
                    indices[iOff++] = b;
                    indices[iOff++] = e;
                    indices[iOff++] = d;
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
