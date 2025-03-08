import { Scene, Mesh, Vector3 } from "@babylonjs/core";
import { WorkerPool } from "./workerPool";
import { Terrain } from "../terrain";
import { TerrainShader } from "../terrainShader";
import { Face, QuadTree } from "./quadTree";

/**
 * Class dedicated to forging chunk meshes using a worker
 *
 * Handles sending data to the WorkerPool and building the mesh from worker data
 */
export class ChunkForge {
    private scene: Scene;
    private workerPool: WorkerPool;

    /**
     * Creates a new ChunkForge instance
     *
     * @param scene - Babylon.js scene
     * @param workerPool - WorkerPool instance
     */
    constructor(scene: Scene, workerPool: WorkerPool) {
        this.scene = scene;
        this.workerPool = workerPool;
    }

    /**
     * Forges a mesh for a chunk using a worker
     *
     * @param taskData - Contains bounds, resolution, radius, face, level, and maxLevel
     * @param cameraPosition - Camera position for priority calculation
     * @param parentEntity - Parent entity to attach the mesh
     * @param center - Pre-calculated center of the chunk
     * @returns A promise resolving to the generated Mesh
     */
    async forge(
        taskData: {
            bounds: any;
            resolution: number;
            radius: number;
            face: Face;
            level: number;
            maxLevel: number;
        },
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3
    ): Promise<Mesh> {
        return new Promise<Mesh>((resolve) => {
            const priority = Vector3.Distance(center, cameraPosition);

            this.workerPool.enqueueTask({
                data: taskData,
                priority: priority,
                callback: (meshData: any) => {
                    const terrainMesh = Terrain.createMeshFromWorker(
                        this.scene,
                        meshData,
                        taskData.face,
                        taskData.level
                    );

                    terrainMesh.parent = parentEntity;
                    terrainMesh.checkCollisions = true;

                    terrainMesh.material = new TerrainShader(this.scene).create(
                        taskData.resolution,
                        taskData.level,
                        taskData.maxLevel,
                        cameraPosition,
                        taskData.radius,
                        center,
                        true,
                        QuadTree.debugLODEnabled
                    );

                    terrainMesh.alwaysSelectAsActiveMesh = true;
                    resolve(terrainMesh);
                },
            });
        });
    }
}
