import { Scene, Mesh, Vector3 } from '@babylonjs/core';
import { ChunkTree, } from './chunk_tree';
import { Terrain } from '../../../game_objects/planets/rocky_planet/terrain';
import { TerrainShader } from '../../../game_objects/planets/rocky_planet/terrains_shader';
import { WorkerPool } from '../workers/worker_pool';
import { Bounds, Face } from '../types';
import { MeshKernelBuildChunkRequest } from '../workers/worker-protocol';

function makeJobId(): string {
    return (globalThis.crypto?.randomUUID?.() ?? `job-${Date.now()}-${Math.random()}`);
}

/**
 * Interface for chunk generation parameters shared by local and server generation
 */
interface ChunkGenerationParams {
    bounds: Bounds;
    resolution: number;
    radius: number;
    face: Face;
    level: number;
    maxLevel: number;
}

/**
 * Interface defining the shared methods for chunk forging
 */
interface IChunkForge {
    worker(
        params: ChunkGenerationParams,
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3,
        wireframe: boolean,
        boundingBox: boolean
    ): Promise<Mesh>;
}

/**
 * Class for forging chunk meshes using Web Worker or server via Socket.IO
 *
 * Implements IChunkForge; both worker() and server() share the same parameters via ChunkGenerationParams
 */
export class ChunkForge implements IChunkForge {
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
     * Builds a terrain mesh from computed mesh data
     *
     * Used by both worker() and server()
     *
     * @param meshData - Computed mesh data (positions, indices, normals, uvs)
     * @param params - Chunk generation parameters
     * @param cameraPosition - Camera position for shader creation
     * @param parentEntity - Parent entity to attach the mesh
     * @param center - Pre-calculated center of the chunk
     * @param wireframe - Whether to render the mesh in wireframe mode
     * @param boundingBox - Whether to show the bounding box for the mesh
     * @returns The generated Mesh
     */
    private buildMesh(
        meshData: any,
        params: ChunkGenerationParams,
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3,
        wireframe: boolean,
        boundingBox: boolean
    ): Mesh {
        const terrainMesh = Terrain.createMesh(
            this.scene,
            meshData,
            params.face,
            params.level
        );

        terrainMesh.metadata = terrainMesh.metadata ?? {};
        if (meshData?.boundsInfo) {
            terrainMesh.metadata.boundsInfo = meshData.boundsInfo;
        }
        terrainMesh.parent = parentEntity;
        terrainMesh.checkCollisions = true;
        terrainMesh.showBoundingBox = boundingBox;

        terrainMesh.material = new TerrainShader(this.scene).create(
            params.resolution,
            params.level,
            params.maxLevel,
            cameraPosition,
            params.radius,
            center,
            wireframe,
            ChunkTree.debugLODEnabled
        );
        terrainMesh.alwaysSelectAsActiveMesh = true;
        return terrainMesh;
    }

    /**
     * Forges a mesh for a chunk using a worker
     *
     * @param params - Chunk generation parameters
     * @param cameraPosition - Camera position for priority calculation and shader creation
     * @param parentEntity - Parent entity to attach the mesh
     * @param center - Pre-calculated center of the chunk
     * @param wireframe - Whether to render the mesh in wireframe mode
     * @returns A promise resolving to the generated Mesh
     */
    async worker(
        params: ChunkGenerationParams,
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3,
        wireframe: boolean,
        boundingBox: boolean
    ): Promise<Mesh> {
        return new Promise<Mesh>((resolve, reject) => {
            const priority = Vector3.Distance(center, cameraPosition);
            const job: MeshKernelBuildChunkRequest = {
                protocol: "mesh-kernel/1",
                kind: "build_chunk",
                id: makeJobId(),
                payload: {
                    ...params,
                    noise: { seed: 1 },
                    meshFormat: "arrays",
                },
            };

            this.workerPool.enqueueTask({
                data: job,
                priority,
                callback: (meshData: any) => {
                    const mesh = this.buildMesh(
                        meshData,
                        params,
                        cameraPosition,
                        parentEntity,
                        center,
                        wireframe,
                        boundingBox
                    );
                    resolve(mesh);
                },
                onError: (e: any) => reject(e),
            });
        });
    }
}
