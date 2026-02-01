import { Scene, Mesh, Vector3, VertexData } from "@babylonjs/core";
import { Face } from "../../../systems/lod/types";

export type MeshDataLike = {
    positions: number[] | Float32Array;
    normals: number[] | Float32Array;
    uvs: number[] | Float32Array;
    indices: number[] | Uint16Array | Uint32Array;
    boundsInfo?: any;
};

/**
 * Terrain handles geometry creation for terrain chunks
 *
 * Provides methods for transforming UV coordinates to cube space
 * and for creating a Babylon.js mesh from computed vertex data
 */
export class Terrain {
    /**
     * Transforms UV coordinates to cube coordinates based on face
     *
     * Expects u and v values to be adjusted via tan() in mesh creation
     *
     * @param u - U coordinate
     * @param v - V coordinate
     * @param face - Face of planet
     * @returns Cube space coordinates as Vector3
     */
    static mapUVtoCube(u: number, v: number, face: Face): Vector3 {
        switch (face) {
            case "front":
                return new Vector3(u, v, 1);
            case "back":
                return new Vector3(-u, v, -1);
            case "left":
                return new Vector3(-1, v, u);
            case "right":
                return new Vector3(1, v, -u);
            case "top":
                return new Vector3(u, 1, -v);
            case "bottom":
                return new Vector3(u, -1, v);
            default:
                return new Vector3(u, v, 1);
        }
    }

    /**
     * Creates a Babylon.js mesh from computed geometry data
     *
     * Called after worker completes geometry calculations
     *
     * @param scene - Babylon.js scene
     * @param meshData - Computed geometry data (positions, indices, normals, uvs)
     * @param face - Cube face of terrain chunk
     * @param level - Current level of detail
     * @returns Mesh built from vertex data
     */
    static createMesh(
        scene: Scene,
        meshData: MeshDataLike,
        face: Face,
        level: number
    ): Mesh {
        const mesh = new Mesh(`chunk_${face}_${level}`, scene);

        const vd = new VertexData();

        // Babylon accepts typed arrays; cast to any to avoid TS friction.
        vd.positions = meshData.positions as any;
        vd.normals = meshData.normals as any;
        vd.uvs = meshData.uvs as any;
        vd.indices = meshData.indices as any;

        vd.applyToMesh(mesh, true);
        return mesh;
    }
}
