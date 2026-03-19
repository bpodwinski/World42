import { Scene, Mesh, Vector3, VertexData } from "@babylonjs/core";
import { Face } from "../../../systems/lod/types";
import type { ChunkBoundsInfo } from "../../../systems/lod/workers/worker_protocol";

type FloatLike = Float32Array | number[] | ReadonlyArray<number>;
type IndexLike = Uint16Array | Uint32Array | number[] | ReadonlyArray<number>;

export type MeshDataLike = {
    positions: FloatLike;
    sgCoarse: FloatLike;
    sgDetail: FloatLike;
    morphDeltas?: FloatLike;
    uvs: FloatLike;
    indices: IndexLike;
    boundsInfo?: ChunkBoundsInfo;
};

function isMutableNumberArray(a: unknown): a is number[] {
    return Array.isArray(a);
}

function toFloatArray(a: FloatLike): Float32Array | number[] {
    if (a instanceof Float32Array) return a;
    if (isMutableNumberArray(a)) return a;      // évite copie si déjà un array normal
    return Array.from(a);                       // DeepImmutableArray / readonly -> number[]
}

function toIndexArray(a: IndexLike): Uint16Array | Uint32Array | number[] {
    if (a instanceof Uint16Array || a instanceof Uint32Array) return a;
    if (isMutableNumberArray(a)) return a;
    return Array.from(a);
}

export class Terrain {
    static mapUVtoCube(u: number, v: number, face: Face): Vector3 {
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

    static createMesh(scene: Scene, meshData: MeshDataLike, face: Face, level: number): Mesh {
        const mesh = new Mesh(`chunk_${face}_${level}`, scene);
        const positions = toFloatArray(meshData.positions);
        const positionCount = positions.length / 3;
        const morphDeltas =
            meshData.morphDeltas
                ? toFloatArray(meshData.morphDeltas)
                : new Float32Array(positionCount * 3);

        const vd = new VertexData();
        vd.positions = positions;
        vd.uvs = toFloatArray(meshData.uvs);
        vd.indices = toIndexArray(meshData.indices);

        vd.applyToMesh(mesh, false);
        mesh.setVerticesData('sgCoarse', toFloatArray(meshData.sgCoarse), false, 3);
        mesh.setVerticesData('sgDetail', toFloatArray(meshData.sgDetail), false, 3);
        mesh.setVerticesData('morphDelta', morphDeltas, false, 3);

        return mesh;
    }
}
