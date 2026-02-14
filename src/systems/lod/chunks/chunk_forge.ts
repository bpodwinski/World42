import { Scene, Mesh, Vector3, TransformNode, Matrix, ShaderMaterial } from "@babylonjs/core";
import { ChunkTree } from "./chunk_tree";
import { Terrain } from "../../../game_objects/planets/rocky_planet/terrain";
import { TerrainShader, TerrainShadowContext } from "../../../game_objects/planets/rocky_planet/terrains_shader";
import type { FloatingEntityInterface } from "../../../core/camera/camera_manager";
import { WorkerPool } from "../workers/worker_pool";
import type { Bounds, Face } from "../types";
import type { MeshKernelBuildChunkRequest } from "../workers/worker_protocol";

/**
 * Enables detailed timings for worker + Babylon mesh/material construction.
 * Keep false in production (spam + perf).
 */
const DEBUG_MESH_TIMINGS = false;

/**
 * Create a unique id for a mesh generation job.
 *
 * @remarks
 * Uses `crypto.randomUUID()` when available, otherwise falls back to a timestamp-based id.
 */
function makeJobId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `job-${Date.now()}-${Math.random()}`;
}

/**
 * Parameters that fully describe a quadsphere chunk to generate.
 *
 * @remarks
 * Coordinate spaces:
 * - `bounds` are in **tan(angle) space** (stable subdivision via atan/tan).
 * - Mesh vertices produced by the worker are in **planet-local** space.
 */
interface ChunkGenerationParams {
    /** Chunk UV bounds in tan(angle) space. */
    bounds: Bounds;

    /** Grid resolution of the patch (typically produces (resolution+1)^2 vertices). */
    resolution: number;

    /** Planet radius in simulation units. */
    radius: number;

    /** Quadsphere face identifier. */
    face: Face;

    /** LOD level for this chunk (0 = largest). */
    level: number;

    /** Maximum LOD level in the quadtree. */
    maxLevel: number;
}

/**
 * ChunkForge builds terrain chunk meshes via a worker pool and attaches them to the scene.
 *
 * @remarks
 * Responsibilities:
 * - Enqueue `mesh-kernel/1 build_chunk` jobs in {@link WorkerPool}.
 * - Convert returned mesh data into a Babylon {@link Mesh}.
 * - Attach the mesh under `renderParent` (planet rotation pivot).
 * - Assign {@link ShaderMaterial} (TerrainShader) and per-chunk lighting.
 *
 * Coordinate spaces (critical):
 * - `cameraWorldDouble`, `planetEntity.doublepos`, `patchCenterWorldDouble`, `starPosWorldDouble` are **WorldDouble**.
 * - Worker mesh positions/normals and shader inputs like `uPatchCenter` are **planet-local**.
 * - Conversions WorldDouble -> planet-local are done using `renderParent` world matrix inverse.
 */
export class ChunkForge {
    private scene: Scene;
    private workerPool: WorkerPool;

    // Cached temporaries to avoid allocations per chunk.
    private _cameraLocal = new Vector3();
    private _invWorld = new Matrix();
    private _rotatedLocal = new Vector3();
    private _patchCenterLocal = new Vector3();
    private _lightDir = new Vector3();
    private _lightDirLocal = new Vector3();

    /**
     * @param scene Babylon scene used to create meshes/materials.
     * @param workerPool Pool used to generate chunk geometry asynchronously.
     */
    constructor(scene: Scene, workerPool: WorkerPool) {
        this.scene = scene;
        this.workerPool = workerPool;
    }

    /**
     * Build a Babylon mesh from worker-returned geometry and assign the terrain shader.
     *
     * @param meshData Raw mesh payload returned by the worker (typed arrays / arrays).
     * @param params Chunk generation parameters.
     * @param cameraWorldDouble Camera position in **WorldDouble**.
     * @param planetEntity Floating planet entity (provides `doublepos` in **WorldDouble**).
     * @param renderParent TransformNode that carries planet rotation (mesh is parented under it).
     * @param patchCenterWorldDouble Patch center in **WorldDouble** (used for priority / debug).
     * @param starPosWorldDouble Star position in **WorldDouble** (nullable if no star).
     * @param starColor Star light color (linear RGB).
     * @param starIntensity Star light intensity scalar.
     * @param wireframe Enables wireframe rendering (debug).
     * @param boundingBox Enables Babylon bounding box rendering (debug).
     *
     * @returns The created Babylon {@link Mesh} (disabled by default; ChunkTree controls visibility).
     *
     * @remarks
     * The worker mesh is **planet-local**. We parent it to `renderParent` (planet pivot).
     * Lighting direction is computed in **WorldDouble** then converted into **planet-local**.
     */
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

        // Important: avoid 1-frame flash; ChunkTree decides when to enable.
        terrainMesh.setEnabled(true);

        const tMesh1 = performance.now();

        // Optional worker-provided bounds, stored for culling/SSE.
        terrainMesh.metadata = terrainMesh.metadata ?? {};
        if (meshData?.boundsInfo) terrainMesh.metadata.boundsInfo = meshData.boundsInfo;

        // Chunks under node_* (planet rotation pivot).
        terrainMesh.parent = renderParent;
        terrainMesh.checkCollisions = true;
        terrainMesh.showBoundingBox = boundingBox;
        terrainMesh.alwaysSelectAsActiveMesh = false;

        const planetCenterWorldDouble = planetEntity.doublepos;

        // Inverse world matrix of planet pivot (rotation carrier) for WorldDouble -> planet-local directions
        renderParent.getWorldMatrix().invertToRef(this._invWorld);

        // cameraLocal = inverse(planetPivotRotation) * (cameraWorldDouble - planetCenterWorldDouble)
        cameraWorldDouble.subtractToRef(planetCenterWorldDouble, this._rotatedLocal);
        Vector3.TransformNormalToRef(this._rotatedLocal, this._invWorld, this._cameraLocal);

        // patchCenterLocal = inverse(planetPivotRotation) * (patchCenterWorldDouble - planetCenterWorldDouble)
        patchCenterWorldDouble.subtractToRef(planetCenterWorldDouble, this._rotatedLocal);
        Vector3.TransformNormalToRef(this._rotatedLocal, this._invWorld, this._patchCenterLocal);

        // cameraLocal = inverse(planetPivotRotation) * (cameraWorldDouble - planetCenterWorldDouble)
        cameraWorldDouble.subtractToRef(planetCenterWorldDouble, this._rotatedLocal);
        renderParent.getWorldMatrix().invertToRef(this._invWorld);
        Vector3.TransformNormalToRef(this._rotatedLocal, this._invWorld, this._cameraLocal);

        const tMat0 = performance.now();

        /**
         * NOTE:
         * - The shader operates primarily in planet-local space.
         * - If TerrainShader expects camera in planet-local, pass `_cameraLocal` instead of `cameraWorldDouble`.
         *   (Keep consistent across shader code/uniforms.)
         */
        const mat = new TerrainShader(this.scene).create(
            params.resolution,
            params.level,
            params.maxLevel,
            this._cameraLocal,
            params.radius,
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

            // Convert to planet-local using inverse pivot rotation.
            Vector3.TransformNormalToRef(this._lightDir, this._invWorld, this._lightDirLocal);
            if (this._lightDirLocal.lengthSquared() < 1e-12) this._lightDirLocal.set(1, 0, 0);
            else this._lightDirLocal.normalize();

            mat.setVector3("lightDirection", this._lightDirLocal);
        }

        terrainMesh.material = sm;

        const shadowCtx = (this.scene.metadata as any)?.terrainShadow as TerrainShadowContext | null | undefined;
        if (shadowCtx) {
            terrainMesh.receiveShadows = true;
            shadowCtx.shadowGen.addShadowCaster(terrainMesh);
            terrainMesh.onDisposeObservable.add(() => {
                shadowCtx.shadowGen.removeShadowCaster(terrainMesh, true);
            });
        }

        const tMat1 = performance.now();

        if (DEBUG_MESH_TIMINGS) {
            console.log(
                `[mesh] babylon mesh=${(tMesh1 - tMesh0).toFixed(2)}ms material=${(tMat1 - tMat0).toFixed(2)}ms` +
                ` face=${params.face} level=${params.level} res=${params.resolution}`
            );
        }

        return terrainMesh;
    }

    /**
     * Enqueue a worker job to generate chunk geometry, then build the Babylon mesh on completion.
     *
     * @param params Chunk generation parameters.
     * @param cameraWorldDouble Camera position in **WorldDouble** (used for job priority).
     * @param planetEntity Floating planet entity (WorldDouble center).
     * @param renderParent Planet pivot node (rotation carrier).
     * @param patchCenterWorldDouble Patch center in **WorldDouble** (priority + logs).
     * @param starPosWorldDouble Star position in **WorldDouble** or null.
     * @param starColor Star light color.
     * @param starIntensity Star light intensity scalar.
     * @param wireframe Wireframe rendering toggle.
     * @param boundingBox Show Babylon bounding box toggle.
     *
     * @returns A promise resolving with the created Babylon {@link Mesh}.
     *
     * @remarks
     * The returned mesh is disabled by default; ChunkTree controls enable/disable depending on visibility.
     */
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
                        octaves: 16,
                        baseFrequency: 20.0,
                        baseAmplitude: 15.0,
                        lacunarity: 1.8,
                        persistence: 0.5,
                        globalTerrainAmplitude: 80.0,
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
                            this._cameraLocal,
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
                            const vtx = stats?.vertexCount ?? (meshData?.positions?.length ?? 0) / 3;
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
