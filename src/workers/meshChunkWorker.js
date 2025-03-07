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
    /**
     * Creates new instance of Vector3
     * @param {number} x - X component
     * @param {number} y - Y component
     * @param {number} z - Z component
     */
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    /**
     * Calculates distance between two vectors
     * @param {Vector3} v1 - First vector
     * @param {Vector3} v2 - Second vector
     * @returns {number} Euclidean distance between v1 and v2
     */
    static Distance(v1, v2) {
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        const dz = v2.z - v1.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /**
     * Normalizes vector
     * @returns {Vector3} New normalized vector
     */
    normalize() {
        const len = Math.sqrt(
            this.x * this.x + this.y * this.y + this.z * this.z
        );
        if (len === 0) {
            // Avoid division by zero
            return new Vector3(0, 0, 0);
        }
        return new Vector3(this.x / len, this.y / len, this.z / len);
    }

    /**
     * Scales vector by a given scalar
     * @param {number} s - Scalar value to multiply
     * @returns {Vector3} New scaled vector
     */
    scale(s) {
        return new Vector3(this.x * s, this.y * s, this.z * s);
    }
}

/**
 * Computes mesh data for terrain chunk
 *
 * @param {{ uMin: number; uMax: number; vMin: number; vMax: number }} bounds - The UV bounds of the chunk
 * @param {number} resolution - The resolution of the grid
 * @param {number} radius - The radius of the sphere
 * @param {"front" | "back" | "left" | "right" | "top" | "bottom"} face - The face of the cube
 * @param {number} level - The current level of detail
 * @param {number} maxLevel - The maximum level of detail
 * @returns {{ positions: number[]; indices: number[]; normals: number[]; uvs: number[] }} The computed mesh data
 */
function computeChunkMeshData(bounds, resolution, radius, face) {
    const positions = [];
    const indices = [];
    const normals = [];
    const uvs = [];
    const res = resolution;

    // Calculate boundary angles from UV bounds
    const angleUMin = Math.atan(bounds.uMin);
    const angleUMax = Math.atan(bounds.uMax);
    const angleVMin = Math.atan(bounds.vMin);
    const angleVMax = Math.atan(bounds.vMax);

    // Temporary array to store vertices
    const verts = [];

    for (let i = 0; i <= res; i++) {
        const angleV = angleVMin + (angleVMax - angleVMin) * (i / res);

        for (let j = 0; j <= res; j++) {
            const angleU = angleUMin + (angleUMax - angleUMin) * (j / res);

            // Transform based on the face
            const posCube = mapUVtoCube(
                Math.tan(angleU),
                Math.tan(angleV),
                face
            );

            // Project on sphere
            const posSphere = posCube.normalize().scale(radius);

            verts.push(posSphere);
            positions.push(posSphere.x, posSphere.y, posSphere.z);
            normals.push(
                posSphere.x / radius,
                posSphere.y / radius,
                posSphere.z / radius
            );
            uvs.push(j / res, i / res);
        }
    }

    // Build indices for triangles
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

            if (d1 < d2) {
                indices.push(index0, index3, index1);
                indices.push(index0, index2, index3);
            } else {
                indices.push(index0, index2, index1);
                indices.push(index1, index2, index3);
            }
        }
    }
    return { positions, indices, normals, uvs };
}

/**
 * Maps UV coordinates to cube coordinates based on the specified face
 *
 * @param {number} u - U coordinate
 * @param {number} v - V coordinate
 * @param {"front" | "back" | "left" | "right" | "top" | "bottom"} face - Face of cube
 * @returns {Vector3} Corresponding 3D vector on the cube
 */
function mapUVtoCube(u, v, face) {
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
 * Handles incoming messages to the worker
 * Expects a message with properties: bounds, resolution, radius, face, level, and maxLevel
 * Computes the mesh data and posts the result back
 *
 * @param {MessageEvent} event - The message event containing the mesh parameters
 */
self.onmessage = (event) => {
    const start = performance.now();

    const { bounds, resolution, radius, face } = event.data;
    const meshData = computeChunkMeshData(bounds, resolution, radius, face);

    self.postMessage(meshData);

    console.log("Chunk created at: " + (performance.now() - start) + "ms");
};
