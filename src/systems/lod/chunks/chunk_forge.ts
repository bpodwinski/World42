import { Scene, Mesh, Vector3, TransformNode, Matrix, ShaderMaterial } from "@babylonjs/core";
import { ChunkTree } from "./chunk_tree";
import { Terrain } from "../../../game_objects/planets/rocky_planet/terrain";
import { TerrainShader } from "../../../game_objects/planets/rocky_planet/terrains_shader";
import type { FloatingEntityInterface } from "../../../core/camera/camera_manager";
import { WorkerPool } from "../workers/worker_pool";
import type { Bounds, Face } from "../types";
import type { MeshKernelBuildChunkRequest } from "../workers/worker_protocol";

const DEBUG_MESH_TIMINGS = false;

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

    private _invWorld = new Matrix();
    private _rotatedLocal = new Vector3();
    private _patchCenterLocal = new Vector3();
    private _lightDir = new Vector3();
    private _lightDirLocal = new Vector3();

    constructor(scene: Scene, workerPool: WorkerPool) {
        this.scene = scene;
        this.workerPool = workerPool;
    }

    private buildMesh(
        meshData: any,
        params: ChunkGenerationParams,
        cameraWorldDouble: Vector3,
        planetEntity: FloatingEntityInterface,
        renderParent: TransformNode,
        patchCenterWorldDouble: Vector3,
        starPosWorldDouble: Vector3 | null,
        starColor: Vector3,
        starIntensity: number,
        wireframe: boolean,
        boundingBox: boolean
    ): Mesh {
        const tMesh0 = performance.now();
        const terrainMesh = Terrain.createMesh(this.scene, meshData, params.face, params.level);
        const tMesh1 = performance.now();

        terrainMesh.metadata = terrainMesh.metadata ?? {};
        if (meshData?.boundsInfo) terrainMesh.metadata.boundsInfo = meshData.boundsInfo;

        // ✅ chunks sous node_* (rotation planète)
        terrainMesh.parent = renderParent;
        terrainMesh.checkCollisions = true;
        terrainMesh.showBoundingBox = boundingBox;
        terrainMesh.alwaysSelectAsActiveMesh = true;

        const planetCenterWorldDouble = planetEntity.doublepos;

        // patchCenterLocal = inverse(rotation(node_*)) * (patchCenterWorld - planetCenterWorld)
        patchCenterWorldDouble.subtractToRef(planetCenterWorldDouble, this._rotatedLocal);
        renderParent.getWorldMatrix().invertToRef(this._invWorld);
        Vector3.TransformNormalToRef(this._rotatedLocal, this._invWorld, this._patchCenterLocal);

        const tMat0 = performance.now();

        const mat = new TerrainShader(this.scene).create(
            params.resolution,
            params.level,
            params.maxLevel,
            cameraWorldDouble,
            params.radius,
            planetCenterWorldDouble,
            this._patchCenterLocal,
            wireframe,
            ChunkTree.debugLODEnabled
        ) as ShaderMaterial;

        terrainMesh.material = mat;

        const sm = mat as ShaderMaterial;

        // Lighting (PER-CHUNK, multi-systèmes)
        mat.setVector3("lightColor", starColor);
        mat.setFloat("lightIntensity", starIntensity);

        if (starPosWorldDouble) {
            // lightDirWorld = star -> planet (WorldDouble)
            planetCenterWorldDouble.subtractToRef(starPosWorldDouble, this._lightDir);
            if (this._lightDir.lengthSquared() < 1e-12) this._lightDir.set(1, 0, 0);
            else this._lightDir.normalize();

            // Convertir en planète-local (inverse rotation du pivot node_*)
            renderParent.getWorldMatrix().invertToRef(this._invWorld);
            Vector3.TransformNormalToRef(this._lightDir, this._invWorld, this._lightDirLocal);
            if (this._lightDirLocal.lengthSquared() < 1e-12) this._lightDirLocal.set(1, 0, 0);
            else this._lightDirLocal.normalize();

            mat.setVector3("lightDirection", this._lightDirLocal);
        }

        terrainMesh.material = sm;

        const tMat1 = performance.now();

        if (DEBUG_MESH_TIMINGS) {
            console.log(
                `[mesh] babylon mesh=${(tMesh1 - tMesh0).toFixed(2)}ms material=${(tMat1 - tMat0).toFixed(2)}ms` +
                ` face=${params.face} level=${params.level} res=${params.resolution}`
            );
        }

        return terrainMesh;
    }

    async worker(
        params: ChunkGenerationParams,
        cameraWorldDouble: Vector3,
        planetEntity: FloatingEntityInterface,
        renderParent: TransformNode,
        patchCenterWorldDouble: Vector3,
        starPosWorldDouble: Vector3 | null,
        starColor: Vector3,
        starIntensity: number,
        wireframe: boolean,
        boundingBox: boolean
    ): Promise<Mesh> {
        return new Promise<Mesh>((resolve, reject) => {
            const priority = Vector3.Distance(patchCenterWorldDouble, cameraWorldDouble);
            const jobId = makeJobId();
            const t0 = performance.now();

            const job: MeshKernelBuildChunkRequest = {
                protocol: "mesh-kernel/1",
                kind: "build_chunk",
                id: jobId,
                payload: {
                    ...params,
                    noise: {
                        seed: 1,
                        octaves: 8,
                        baseFrequency: 20.0,
                        baseAmplitude: 10.0,
                        lacunarity: 2.0,
                        persistence: 0.5,
                        globalTerrainAmplitude: 10.0
                    },
                    meshFormat: "typed",
                },
            };

            this.workerPool.enqueueTask({
                data: job,
                priority,
                callback: (meshData: any, stats?: any) => {
                    try {
                        const tBuild0 = performance.now();
                        const mesh = this.buildMesh(
                            meshData,
                            params,
                            cameraWorldDouble,
                            planetEntity,
                            renderParent,
                            patchCenterWorldDouble,
                            starPosWorldDouble,
                            starColor,
                            starIntensity,
                            wireframe,
                            boundingBox
                        );
                        const tBuild1 = performance.now();
                        const t1 = performance.now();

                        if (DEBUG_MESH_TIMINGS) {
                            const workerMs = stats?.ms ?? NaN;
                            const vtx = stats?.vertexCount ?? ((meshData?.positions?.length ?? 0) / 3);
                            const idx = stats?.indexCount ?? (meshData?.indices?.length ?? 0);

                            console.log(
                                `[mesh] job=${jobId} total=${(t1 - t0).toFixed(2)}ms` +
                                ` worker=${isNaN(workerMs) ? "?" : workerMs.toFixed(2)}ms` +
                                ` build=${(tBuild1 - tBuild0).toFixed(2)}ms` +
                                ` vtx=${vtx} idx=${idx}` +
                                ` face=${params.face} level=${params.level} res=${params.resolution}`
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
