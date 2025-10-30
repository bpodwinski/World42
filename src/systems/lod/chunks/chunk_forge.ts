import { Scene, Mesh, Vector3 } from '@babylonjs/core';
import { Face, ChunkTree, Bounds } from './chunk_tree';
import { Socket } from 'socket.io-client';
import { Terrain } from '../../../game_objects/planets/rocky_planet/terrain';
import { TerrainShader } from '../../../game_objects/planets/rocky_planet/terrains_shader';
import { WorkerPool } from '../workers/worker_pool';

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
        center: Vector3
    ): Promise<Mesh>;

    server(
        params: ChunkGenerationParams,
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3
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
    private socket?: Socket;

    /**
     * Creates a new ChunkForge instance
     *
     * @param scene - Babylon.js scene
     * @param workerPool - WorkerPool instance
     * @param socket - Optional Socket.IO client instance
     */
    constructor(scene: Scene, workerPool: WorkerPool, socket?: Socket) {
        this.scene = scene;
        this.workerPool = workerPool;
        this.socket = socket;
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
     * @returns The generated Mesh
     */
    private buildMesh(
        meshData: any,
        params: ChunkGenerationParams,
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3
    ): Mesh {
        const terrainMesh = Terrain.createMesh(
            this.scene,
            meshData,
            params.face,
            params.level
        );
        terrainMesh.parent = parentEntity;
        terrainMesh.checkCollisions = true;

        terrainMesh.material = new TerrainShader(this.scene).create(
            params.resolution,
            params.level,
            params.maxLevel,
            cameraPosition,
            params.radius,
            center,
            false,
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
     * @returns A promise resolving to the generated Mesh
     */
    async worker(
        params: ChunkGenerationParams,
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3
    ): Promise<Mesh> {
        return new Promise<Mesh>((resolve) => {
            const priority = Vector3.Distance(center, cameraPosition);
            this.workerPool.enqueueTask({
                data: params,
                priority: priority,
                callback: (meshData: any) => {
                    const mesh = this.buildMesh(
                        meshData,
                        params,
                        cameraPosition,
                        parentEntity,
                        center
                    );
                    resolve(mesh);
                }
            });
        });
    }

    /**
     * Forges a mesh for a chunk using server-side generation via Socket.IO
     *
     * @param params - Chunk generation parameters
     * @param cameraPosition - Camera position for shader creation
     * @param parentEntity - Parent entity to attach the mesh
     * @param center - Pre-calculated center of the chunk
     * @returns A promise resolving to the generated Mesh
     */
    async server(
        params: ChunkGenerationParams,
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3
    ): Promise<Mesh> {
        return new Promise<Mesh>((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('Socket instance not available'));
                return;
            }
            this.socket.emit('generateChunk', params);
            this.socket.once('chunkData', (meshData: any) => {
                try {
                    const mesh = this.buildMesh(
                        meshData,
                        params,
                        cameraPosition,
                        parentEntity,
                        center
                    );
                    resolve(mesh);
                } catch (error) {
                    reject(error);
                }
            });
            this.socket.once('chunkError', (error: any) => {
                reject(
                    new Error(error.message || 'Server chunk generation failed')
                );
            });
        });
    }
}
