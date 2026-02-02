import { Scene, Mesh, Vector3 } from "@babylonjs/core";
import { ChunkTree } from "./chunk_tree";
import { Terrain } from "../../../game_objects/planets/rocky_planet/terrain";
import { TerrainShader } from "../../../game_objects/planets/rocky_planet/terrains_shader";
import { WorkerPool } from "../workers/worker_pool";
import type { Bounds, Face } from "../types";
import type { MeshKernelBuildChunkRequest } from "../workers/worker_protocol";

const DEBUG_MESH_TIMINGS = true;

function makeJobId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `job-${Date.now()}-${Math.random()}`;
}

interface ChunkGenerationParams {
    bounds: Bounds;
    resolution: number;
    radius: number;
    face: Face;
    level: number;
    maxLevel: number;
}

export class ChunkForge {
    private scene: Scene;
    private workerPool: WorkerPool;

    constructor(scene: Scene, workerPool: WorkerPool) {
        this.scene = scene;
        this.workerPool = workerPool;
    }

    private buildMesh(
        meshData: any,
        params: ChunkGenerationParams,
        cameraPosition: Vector3,
        parentEntity: any,
        center: Vector3,
        wireframe: boolean,
        boundingBox: boolean
    ): Mesh {
        const tMesh0 = performance.now();
        const terrainMesh = Terrain.createMesh(this.scene, meshData, params.face, params.level);
        const tMesh1 = performance.now();

        terrainMesh.metadata = terrainMesh.metadata ?? {};
        if (meshData?.boundsInfo) terrainMesh.metadata.boundsInfo = meshData.boundsInfo;

        terrainMesh.parent = parentEntity;
        terrainMesh.checkCollisions = true;
        terrainMesh.showBoundingBox = boundingBox;

        const tMat0 = performance.now();
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
        const tMat1 = performance.now();

        if (DEBUG_MESH_TIMINGS) {
            console.log(
                `[mesh] babylon mesh=${(tMesh1 - tMesh0).toFixed(2)}ms material=${(tMat1 - tMat0).toFixed(2)}ms`
                + ` face=${params.face} level=${params.level} res=${params.resolution}`
            );
        }

        terrainMesh.alwaysSelectAsActiveMesh = true;

        return terrainMesh;
    }

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
            const jobId = makeJobId();
            const t0 = performance.now();

            const job: MeshKernelBuildChunkRequest = {
                protocol: "mesh-kernel/1",
                kind: "build_chunk",
                id: jobId,
                payload: {
                    ...params,
                    noise: { seed: 1 },
                    meshFormat: "typed",
                },
            };

            this.workerPool.enqueueTask({
                data: job,
                priority,
                callback: (meshData: any, stats?: any) => {
                    try {
                        const tBuild0 = performance.now();
                        const mesh = this.buildMesh(meshData, params, cameraPosition, parentEntity, center, wireframe, boundingBox);
                        const tBuild1 = performance.now();
                        const t1 = performance.now();

                        if (DEBUG_MESH_TIMINGS) {
                            const workerMs = stats?.ms ?? NaN;
                            const vtx = stats?.vertexCount ?? ((meshData?.positions?.length ?? 0) / 3);
                            const idx = stats?.indexCount ?? (meshData?.indices?.length ?? 0);

                            console.log(
                                `[mesh] job=${jobId} total=${(t1 - t0).toFixed(2)}ms`
                                + ` worker=${isNaN(workerMs) ? "?" : workerMs.toFixed(2)}ms`
                                + ` build=${(tBuild1 - tBuild0).toFixed(2)}ms`
                                + ` vtx=${vtx} idx=${idx}`
                                + ` face=${params.face} level=${params.level} res=${params.resolution}`
                            );
                        }

                        resolve(mesh);
                    } catch (e) {
                        reject(e);
                    }
                },
                onError: reject,
            });
        });
    }
}
