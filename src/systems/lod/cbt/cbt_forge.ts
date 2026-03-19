import { Mesh, Matrix, Scene, ShaderMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import type { FloatingEntityInterface } from '../../../core/camera/camera_manager';
import { Terrain } from '../../../game_objects/planets/rocky_planet/terrain';
import { TerrainShader } from '../../../game_objects/planets/rocky_planet/terrains_shader';
import { ChunkTree } from '../chunks/chunk_tree';
import { WorkerPool } from '../workers/worker_pool';
import type {
    ChunkMeshData,
    MeshKernelBuildTriangleChunkRequest,
    MeshKernelChunkStats,
    MeshKernelNoiseParams,
} from '../workers/worker_protocol';

function makeJobId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `cbt-${Date.now()}-${Math.random()}`;
}

export interface CbtLeafBuildParams {
    v0: [number, number, number];
    v1: [number, number, number];
    v2: [number, number, number];
    resolution: number;
    radius: number;
    level: number;
    maxLevel: number;
}

/**
 * CbtForge builds terrain meshes for CBT leaf triangles via the worker pool.
 *
 * Mirrors ChunkForge but sends `build_triangle_chunk` requests instead of `build_chunk`.
 * Each leaf gets its own Babylon Mesh + TerrainShader.
 */
export class CbtForge {
    private _cameraLocal = new Vector3();
    private _invWorld = new Matrix();
    private _rotatedLocal = new Vector3();
    private _patchCenterLocal = new Vector3();
    private _lightDir = new Vector3();
    private _lightDirLocal = new Vector3();

    constructor(
        private scene: Scene,
        private workerPool: WorkerPool,
        private noise: MeshKernelNoiseParams = {
            seed: 1,
            octaves: 16,
            baseFrequency: 20.0,
            baseAmplitude: 15.0,
            lacunarity: 1.8,
            persistence: 0.5,
            globalTerrainAmplitude: 80.0,
        }
    ) {}

    private buildMesh(
        meshData: ChunkMeshData,
        params: CbtLeafBuildParams,
        cameraWorldDouble: Vector3,
        planetEntity: FloatingEntityInterface,
        renderParent: TransformNode,
        starPosWorldDouble: Vector3 | null,
        starColor: Vector3,
        starIntensity: number
    ): Mesh {
        const terrainMesh = Terrain.createMesh(this.scene, meshData, 'front', params.level);

        terrainMesh.setEnabled(true);
        terrainMesh.parent = renderParent;
        terrainMesh.checkCollisions = false;
        terrainMesh.alwaysSelectAsActiveMesh = false;

        terrainMesh.metadata = terrainMesh.metadata ?? {};
        if (meshData?.boundsInfo) terrainMesh.metadata.boundsInfo = meshData.boundsInfo;

        const planetCenterWorldDouble = planetEntity.doublepos;

        renderParent.getWorldMatrix().invertToRef(this._invWorld);

        cameraWorldDouble.subtractToRef(planetCenterWorldDouble, this._rotatedLocal);
        Vector3.TransformNormalToRef(this._rotatedLocal, this._invWorld, this._cameraLocal);

        // Patch center = centroid of the triangle projected on sphere
        const cx = (params.v0[0] + params.v1[0] + params.v2[0]) / 3;
        const cy = (params.v0[1] + params.v1[1] + params.v2[1]) / 3;
        const cz = (params.v0[2] + params.v1[2] + params.v2[2]) / 3;
        this._patchCenterLocal.set(cx, cy, cz);

        const mat = new TerrainShader(this.scene).create(
            params.resolution,
            params.level,
            params.maxLevel,
            this._cameraLocal,
            params.radius,
            this._patchCenterLocal,
            process.env.CBT_WIREFRAME === '1',
            process.env.CBT_DEBUG_LOD === '1'
        ) as ShaderMaterial;

        terrainMesh.material = mat;

        // Surface gradient detail attenuation based on patch size
        const patchSize = params.radius * Math.pow(2, -params.level);
        mat.setFloat('sgDetailAttenStart', patchSize * 10);
        mat.setFloat('sgDetailAttenEnd', patchSize * 20);

        mat.setVector3('lightColor', starColor);
        mat.setFloat('lightIntensity', starIntensity);

        if (starPosWorldDouble) {
            planetCenterWorldDouble.subtractToRef(starPosWorldDouble, this._lightDir);
            if (this._lightDir.lengthSquared() < 1e-12) this._lightDir.set(1, 0, 0);
            else this._lightDir.normalize();

            Vector3.TransformNormalToRef(this._lightDir, this._invWorld, this._lightDirLocal);
            if (this._lightDirLocal.lengthSquared() < 1e-12) this._lightDirLocal.set(1, 0, 0);
            else this._lightDirLocal.normalize();

            mat.setVector3('lightDirection', this._lightDirLocal);
        }

        if (process.env.SHADOWS !== '0') {
            const shadowCtx = TerrainShader.getTerrainShadowContext(this.scene);
            if (shadowCtx) {
                terrainMesh.receiveShadows = true;
                shadowCtx.near.shadowGen.addShadowCaster(terrainMesh);
                shadowCtx.far.shadowGen.addShadowCaster(terrainMesh);
                terrainMesh.onDisposeObservable.add(() => {
                    shadowCtx.near.shadowGen.removeShadowCaster(terrainMesh, true);
                    shadowCtx.far.shadowGen.removeShadowCaster(terrainMesh, true);
                });
            }
        }

        return terrainMesh;
    }

    async buildLeaf(
        params: CbtLeafBuildParams,
        cameraWorldDouble: Vector3,
        planetEntity: FloatingEntityInterface,
        renderParent: TransformNode,
        starPosWorldDouble: Vector3 | null,
        starColor: Vector3,
        starIntensity: number
    ): Promise<Mesh> {
        return new Promise<Mesh>((resolve, reject) => {
            const cx = (params.v0[0] + params.v1[0] + params.v2[0]) / 3;
            const cy = (params.v0[1] + params.v1[1] + params.v2[1]) / 3;
            const cz = (params.v0[2] + params.v1[2] + params.v2[2]) / 3;

            const dx = cameraWorldDouble.x - planetEntity.doublepos.x - cx;
            const dy = cameraWorldDouble.y - planetEntity.doublepos.y - cy;
            const dz = cameraWorldDouble.z - planetEntity.doublepos.z - cz;
            const priority = Math.sqrt(dx * dx + dy * dy + dz * dz);

            const job: MeshKernelBuildTriangleChunkRequest = {
                protocol: 'mesh-kernel/1',
                kind: 'build_triangle_chunk',
                id: makeJobId(),
                payload: {
                    ...params,
                    noise: this.noise,
                    meshFormat: 'typed',
                },
            };

            this.workerPool.enqueueTask({
                data: job,
                priority,
                callback: (meshData: ChunkMeshData, _stats?: MeshKernelChunkStats) => {
                    try {
                        const mesh = this.buildMesh(
                            meshData,
                            params,
                            cameraWorldDouble,
                            planetEntity,
                            renderParent,
                            starPosWorldDouble,
                            starColor,
                            starIntensity
                        );
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
