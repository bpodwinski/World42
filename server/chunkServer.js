import express from "express";
import http from "http";
import { Server } from "socket.io";
import { performance } from "perf_hooks";
import cors from "cors";

/**
 * Minimal implementation of a 3D vector
 *
 * @class
 */
class Vector3 {
    /**
     * Creates a new Vector3 instance
     *
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
     * Calculates the Euclidean distance between two vectors
     *
     * @param {Vector3} v1 - First vector
     * @param {Vector3} v2 - Second vector
     * @returns {number} Distance between v1 and v2
     */
    static Distance(v1, v2) {
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        const dz = v2.z - v1.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /**
     * Normalizes the vector
     *
     * @returns {Vector3} New normalized vector
     */
    normalize() {
        const len = Math.sqrt(
            this.x * this.x + this.y * this.y + this.z * this.z
        );
        if (len === 0) return new Vector3(0, 0, 0);
        return new Vector3(this.x / len, this.y / len, this.z / len);
    }

    /**
     * Scales the vector by a scalar
     *
     * @param {number} s - Scalar value
     * @returns {Vector3} New scaled vector
     */
    scale(s) {
        return new Vector3(this.x * s, this.y * s, this.z * s);
    }
}

/**
 * Maps UV coordinates to cube coordinates based on the specified face
 *
 * @param {number} u - U coordinate
 * @param {number} v - V coordinate
 * @param {"front"|"back"|"left"|"right"|"top"|"bottom"} face - Cube face
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
 * Computes mesh data for a terrain chunk
 *
 * @param {{ uMin: number, uMax: number, vMin: number, vMax: number }} bounds - The UV bounds of the chunk
 * @param {number} resolution - Grid resolution
 * @param {number} radius - Sphere radius
 * @param {"front"|"back"|"left"|"right"|"top"|"bottom"} face - Cube face
 * @returns {{ positions: number[], indices: number[], normals: number[], uvs: number[] }} Computed mesh data
 */
function computeChunkMeshData(bounds, resolution, radius, face) {
    const positions = [];
    const indices = [];
    const normals = [];
    const uvs = [];
    const res = resolution;

    // Calculate angles from UV bounds
    const angleUMin = Math.atan(bounds.uMin);
    const angleUMax = Math.atan(bounds.uMax);
    const angleVMin = Math.atan(bounds.vMin);
    const angleVMax = Math.atan(bounds.vMax);

    const verts = [];

    for (let i = 0; i <= res; i++) {
        const angleV = angleVMin + (angleVMax - angleVMin) * (i / res);
        for (let j = 0; j <= res; j++) {
            const angleU = angleUMin + (angleUMax - angleUMin) * (j / res);
            const posCube = mapUVtoCube(
                Math.tan(angleU),
                Math.tan(angleV),
                face
            );
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
 * Generates mesh data for a terrain chunk
 *
 * @param {{ bounds: object, resolution: number, radius: number, face: "front"|"back"|"left"|"right"|"top"|"bottom" }} params - Mesh generation parameters
 * @returns {object} Mesh data containing positions, indices, normals, and uvs
 */
function generateChunkMeshData(params) {
    const start = performance.now();
    const { bounds, resolution, radius, face } = params;
    const meshData = computeChunkMeshData(bounds, resolution, radius, face);
    const elapsed = performance.now() - start;
    console.log(`Chunk created in ${elapsed}ms`);
    return meshData;
}

// Setup Express and Socket.IO server
const app = express();

// Ajout du middleware CORS pour autoriser les requêtes cross-origin
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET"],
    },
});

// Serve static files from the "public" folder (if needed)
app.use(express.static("public"));

io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Listen for chunk generation requests
    socket.on("generateChunk", (params) => {
        console.log(
            `Received generateChunk with params: ${JSON.stringify(params)}`
        );
        try {
            const chunkData = generateChunkMeshData(params);
            socket.emit("chunkData", chunkData);
        } catch (error) {
            console.error("Error generating chunk:", error);
            socket.emit("chunkError", { message: error.message });
        }
    });

    socket.on("disconnect", () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 8888;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
