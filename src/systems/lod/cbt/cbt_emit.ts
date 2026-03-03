import type { ChunkMeshDataTyped } from '../workers/worker_protocol';
import type { CbtNode } from './cbt_state';

function sphericalUV(x: number, y: number, z: number, radius: number): [number, number] {
    const nx = x / radius;
    const ny = y / radius;
    const nz = z / radius;

    const u = 0.5 + Math.atan2(nz, nx) / (2 * Math.PI);
    const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI;
    return [u, v];
}

export function emitMeshFromLeaves(
    leaves: ReadonlyArray<CbtNode>,
    radius: number
): ChunkMeshDataTyped {
    const triangleCount = leaves.length;
    const vertexCount = triangleCount * 3;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const morphDeltas = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices =
        vertexCount > 65535
            ? new Uint32Array(vertexCount)
            : new Uint16Array(vertexCount);

    let vtx = 0;
    let uv = 0;

    for (const leaf of leaves) {
        const vertices = [leaf.v0, leaf.v1, leaf.v2] as const;
        for (const vertex of vertices) {
            positions[vtx * 3 + 0] = vertex.x;
            positions[vtx * 3 + 1] = vertex.y;
            positions[vtx * 3 + 2] = vertex.z;

            const invLen = 1 / Math.max(1e-8, Math.sqrt(vertex.x * vertex.x + vertex.y * vertex.y + vertex.z * vertex.z));
            normals[vtx * 3 + 0] = vertex.x * invLen;
            normals[vtx * 3 + 1] = vertex.y * invLen;
            normals[vtx * 3 + 2] = vertex.z * invLen;

            const [u, v] = sphericalUV(vertex.x, vertex.y, vertex.z, radius);
            uvs[uv++] = u;
            uvs[uv++] = v;

            indices[vtx] = vtx;
            vtx++;
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
