import { Scene, Mesh, Vector3, ShaderMaterial, Plane, Quaternion, Matrix } from '@babylonjs/core';
import { ChunkForge } from './chunk_forge';
import { FloatingEntityInterface, OriginCamera } from '../../../core/camera/camera_manager';
import { Terrain } from '../../../game_objects/planets/rocky_planet/terrain';
import { Bounds, Face } from '../types';
import { globalWorkerPool } from '../workers/global_worker_pool';
import { computeSSEPx, distanceToPatchBoundingSphere, isSphereInFrustum } from './chunk_metrics';
import { createFrustumCullCache, frustumCulling } from './frustum_culling';
import { horizonCulling } from './horizon_culling';

/**
 * ChunkTree represents a terrain chunk node and manages hierarchical subdivision (quadtree)
 *
 * Each node owns:
 *  - UV bounds on a cube face
 *  - LOD level
 *  - optional Babylon mesh (generated async via worker pool)
 *  - optional children (4 quadrants)
 */
export class ChunkTree {
    scene: Scene;
    camera: OriginCamera;
    bounds: Bounds;
    level: number;
    maxLevel: number;
    radius: number;
    center: Vector3;
    resolution: number;
    children: ChunkTree[] | null;
    mesh: Mesh | null;
    face: Face;
    parentEntity: FloatingEntityInterface;
    private wireframe: boolean;
    private boundingBox: boolean;
    private frustumCullingEnabled: boolean;
    private horizonCullingEnabled: boolean;
    private chunkForge: ChunkForge;

    // Cache for asynchronous mesh creation to avoid duplicate generation
    private meshPromise: Promise<Mesh> | null = null;

    /**
   * Global cache to store precomputed meshes (optional).
   * Key is derived from face/level/bounds to uniquely identify a chunk.
   * Value is a Promise<Mesh> to deduplicate concurrent precompute requests.
   */
    public static precomputedChunkCache = new Map<string, Promise<Mesh>>();

    // Guard to prevent concurrent updateLOD calls
    private updating: boolean = false;

    // Keeps track of the LOD level for which the mesh was generated
    private currentLODLevel: number | null = null;

    // Flag to enable/disable precompute caching
    private precomputeEnabled: boolean = false;

    private frustumCache = createFrustumCullCache();

    // Debug mode flag (passed to the shader)
    public debugLOD: boolean;
    public static debugLODEnabled: boolean = false;

    /**
     * Creates a new ChunkTree node
     *
     * @param scene - Babylon.js scene used for mesh creation
     * @param camera - Camera used for LOD calculations
     * @param bounds - UV bounds of the terrain chunk
     * @param level - Current LOD level
     * @param maxLevel - Maximum LOD level allowed
     * @param radius - Planet radius in simulation units
     * @param center - Center position of the chunk (simulation units)
     * @param resolution - Grid resolution used to generate the mesh
     * @param face - Cube face for the terrain chunk
     * @param parentEntity - Entity to which the mesh is attached (floating origin)
     * @param wireframe - Whether to render the mesh in wireframe mode
     * @param boundingBox - Whether to show the bounding box for the mesh
     * @param frustumCullingEnabled - Enable frustum culling
     * @param horizonCullingEnabled - Enable horizon culling
     * @param precomputeEnabled - Enables/disables precompute mesh caching
     * @param debugLOD - Whether to enable LOD debug mode
     */
    constructor(
        scene: Scene,
        camera: OriginCamera,
        bounds: Bounds,
        level: number,
        maxLevel: number,
        radius: number,
        center: Vector3,
        resolution: number,
        face: Face,
        parentEntity: FloatingEntityInterface,
        wireframe: boolean = false,
        boundingBox: boolean = false,
        precomputeEnabled: boolean,
        frustumCullingEnabled: boolean = true,
        horizonCullingEnabled: boolean = true,
        debugLOD: boolean = false
    ) {
        this.scene = scene;
        this.camera = camera;
        this.bounds = bounds;
        this.level = level;
        this.maxLevel = maxLevel;
        this.radius = radius;
        this.center = center;
        this.resolution = resolution;
        this.face = face;
        this.children = null;
        this.mesh = null;
        this.parentEntity = parentEntity;
        this.wireframe = wireframe;
        this.boundingBox = boundingBox;
        this.debugLOD = debugLOD;
        this.precomputeEnabled = precomputeEnabled;
        this.frustumCullingEnabled = frustumCullingEnabled;
        this.horizonCullingEnabled = horizonCullingEnabled;
        this.chunkForge = new ChunkForge(this.scene, globalWorkerPool);
    }

    private getPlanetRotationMatrix(): Matrix | null {
        const pe: any = this.parentEntity as any;

        // cas le plus courant: rotationQuaternion exposé directement ou via un node/transform
        const q: Quaternion | undefined =
            pe.rotationQuaternion ??
            pe.node?.rotationQuaternion ??
            pe.transform?.rotationQuaternion;

        if (q) {
            const m = Matrix.Identity();
            q.toRotationMatrix(m);
            return m;
        }

        // fallback: extraire la rotation depuis une world matrix
        const wm =
            pe.getWorldMatrix?.() ??
            pe.node?.getWorldMatrix?.() ??
            pe.transform?.getWorldMatrix?.();

        if (wm && typeof wm.getRotationMatrixToRef === "function") {
            const m = Matrix.Identity();
            wm.getRotationMatrixToRef(m);
            return m;
        }

        return null;
    }

    private planetLocalToWorld(local: Vector3): Vector3 {
        const rot = this.getPlanetRotationMatrix();
        const rotated = rot ? Vector3.TransformCoordinates(local, rot) : local;
        return this.parentEntity.doublepos.add(rotated);
    }

    /**
     * Returns the center position of the chunk in world space.
     *
     * Uses bounds + parentEntity.doublepos to compute a point on the quadsphere at planet radius.
     */
    private getCenterChunk(): Vector3 {
        const { uMin, uMax, vMin, vMax } = this.bounds;

        const angleUMin = Math.atan(uMin);
        const angleUMax = Math.atan(uMax);
        const angleVMin = Math.atan(vMin);
        const angleVMax = Math.atan(vMax);

        const uCenter = Math.tan((angleUMin + angleUMax) * 0.5);
        const vCenter = Math.tan((angleVMin + angleVMax) * 0.5);

        const posCube = Terrain.mapUVtoCube(uCenter, vCenter, this.face);
        const local = posCube.normalize().scale(this.radius); // local planète (origine planète)

        return this.planetLocalToWorld(local); // applique rotation + translation
    }

    /**
     * Returns a unique key for caching this chunk mesh.
     */
    private getChunkCacheKey(): string {
        const { uMin, uMax, vMin, vMax } = this.bounds;
        return `${this.face}_${this.level}_${uMin}_${uMax}_${vMin}_${vMax}`;
    }

    /**
     * Optional precompute: generates and stores the mesh of this chunk in the global cache (RAM).
     * Only runs when precomputeEnabled is true.
     */
    public async precomputeMesh(): Promise<void> {
        if (!this.precomputeEnabled) return;

        const key = this.getChunkCacheKey();
        if (ChunkTree.precomputedChunkCache.has(key)) {
            console.log(`Chunk ${key} already precomputed`);
            return;
        }

        const center = this.getCenterChunk();
        console.log(`Precomputing chunk ${key}...`);

        const meshPromise = this.chunkForge.worker(
            {
                bounds: this.bounds,
                resolution: this.resolution,
                radius: this.radius,
                face: this.face,
                level: this.level,
                maxLevel: this.maxLevel
            },
            this.camera.doublepos,
            this.parentEntity,
            center,
            this.wireframe,
            this.boundingBox
        );

        ChunkTree.precomputedChunkCache.set(key, meshPromise);

        try {
            await meshPromise;
            console.log(`Chunk ${key} precomputed successfully`);
        } catch (e) {
            console.error(`Error while precomputing chunk ${key}:`, e);
        }
    }

    /**
     * Creates a new child node with given bounds.
     */
    private createChild(bounds: Bounds): ChunkTree {
        return new ChunkTree(
            this.scene,
            this.camera,
            bounds,
            this.level + 1,
            this.maxLevel,
            this.radius,
            this.center,
            this.resolution,
            this.face,
            this.parentEntity,
            this.wireframe,
            this.boundingBox,
            this.precomputeEnabled,
            this.frustumCullingEnabled,
            this.horizonCullingEnabled,
            this.debugLOD
        );
    }

    /**
     * Subdivides the current node into four child nodes (quadtree split).
     */
    subdivide(): void {
        this.children = [];
        const { uMin, uMax, vMin, vMax } = this.bounds;
        const uMid = (uMin + uMax) / 2;
        const vMid = (vMin + vMax) / 2;

        const boundsTL: Bounds = { uMin, uMax: uMid, vMin: vMid, vMax };
        const boundsTR: Bounds = { uMin: uMid, uMax, vMin: vMid, vMax };
        const boundsBL: Bounds = { uMin, uMax: uMid, vMin, vMax: vMid };
        const boundsBR: Bounds = { uMin: uMid, uMax, vMin, vMax: vMid };

        this.children.push(this.createChild(boundsTL));
        this.children.push(this.createChild(boundsTR));
        this.children.push(this.createChild(boundsBL));
        this.children.push(this.createChild(boundsBR));
    }

    /**
     * Disposes all child nodes and clears the children array.
     */
    disposeChildren(): void {
        if (!this.children) return;
        this.children.forEach((child) => child.dispose());
        this.children = null;
    }

    /**
     * Deactivates the current node and all children by disabling their meshes.
     */
    deactivate(): void {
        if (this.mesh) this.mesh.setEnabled(false);
        if (this.children) this.children.forEach((child) => child.deactivate());
    }

    /**
     * Disposes the current node mesh and recursively disposes its children.
     */
    dispose(): void {
        if (this.mesh) {
            this.mesh.dispose();
            this.mesh = null;
        }
        if (this.children) {
            this.children.forEach((child) => child.dispose());
            this.children = null;
        }
    }

    // --- SSE tuning knobs (adjust to taste)
    public static sseThresholdPx = 10.0;   // 1..3 = very detailed, 3..6 = better perf
    public static geomErrorScale = 0.6;   // empirical scale factor (depends on terrain)
    public static minDistEpsilon = 1e-3;  // avoids division by zero

    /**
     * Asynchronously updates the Level of Detail (LOD) for this node.
     *
     * Uses SSE (screen-space error) to decide whether to split into children or render the current mesh.
     *
     * @param camera - Camera used for LOD decision
     * @param debugMode - Optional debug flag (not used here, kept for compatibility)
     */
    async updateLOD(camera: OriginCamera, debugMode: boolean = false): Promise<void> {
        if (this.updating) return;
        this.updating = true;

        try {
            const { uMin, uMax, vMin, vMax } = this.bounds;
            const center = this.getCenterChunk();

            // Compute the 4 patch corner positions on the base sphere (radius only)
            const cornersUV = [
                { u: uMin, v: vMin },
                { u: uMin, v: vMax },
                { u: uMax, v: vMin },
                { u: uMax, v: vMax }
            ];

            const corners = cornersUV.map(({ u, v }) => {
                const posCube = Terrain.mapUVtoCube(u, v, this.face);
                const local = posCube.normalize().scale(this.radius); // local planète
                return this.planetLocalToWorld(local);
            });

            // Use bounding sphere distance instead of "min distance to center/corners"
            // Bounding sphere "fallback" basé sur la sphère de base (sans relief)
            const { radius: bsRadiusFallback } =
                distanceToPatchBoundingSphere(camera.doublepos, center, corners);
            const planetCenter = this.parentEntity.doublepos;

            //Bounds propres
            let centerWorld = center; // fallback
            let radiusForCull = bsRadiusFallback; // fallback

            const bi = (this.mesh as any)?.metadata?.boundsInfo;
            const hasAccurateBounds =
                Array.isArray(bi?.centerLocal) &&
                bi.centerLocal.length === 3 &&
                Number.isFinite(bi.boundingRadius);

            if (hasAccurateBounds) {
                const centerLocal = Vector3.FromArray(bi.centerLocal); // local planète (origine planète)
                centerWorld = this.planetLocalToWorld(centerLocal); // world/double
                radiusForCull = bi.boundingRadius; // rayon réel (relief inclus)
            }

            // Frustum culling
            if (this.frustumCullingEnabled) {
                if (hasAccurateBounds) {
                    const visible = frustumCulling(
                        camera,
                        centerWorld,
                        radiusForCull,
                        isSphereInFrustum,
                        this.frustumCache
                    );

                    if (!visible) {
                        this.deactivate();
                        return;
                    }
                }
            }

            // Horizon culling
            if (this.horizonCullingEnabled) {
                if (hasAccurateBounds) {
                    const visible = horizonCulling(
                        camera.doublepos,
                        planetCenter,
                        this.radius,
                        centerWorld,
                        radiusForCull
                    );

                    if (!visible) {
                        this.deactivate();
                        return;
                    }
                }
            }

            // Distance pour SSE cohérente avec radiusForCull
            const dc = Vector3.Distance(camera.doublepos, centerWorld);
            const distanceToPatch = Math.max(0, dc - radiusForCull);

            // SSE decision in pixels
            const ssePx = computeSSEPx({
                scene: this.scene,
                cameraFov: camera.fov,
                distanceToPatch,
                corners,
                resolution: this.resolution,
                geomErrorScale: ChunkTree.geomErrorScale,
                minDistEpsilon: ChunkTree.minDistEpsilon,
            });

            // Split when error is above threshold (and we can still increase detail)
            if (ssePx > ChunkTree.sseThresholdPx && this.level < this.maxLevel) {
                if (!this.children) {
                    this.subdivide();

                    // Forge meshes for all children
                    await Promise.all(
                        this.children!.map(async (child) => {
                            child.mesh = await child.chunkForge.worker(
                                {
                                    bounds: child.bounds,
                                    resolution: child.resolution,
                                    radius: child.radius,
                                    face: child.face,
                                    level: child.level,
                                    maxLevel: child.maxLevel
                                },
                                this.camera.doublepos,
                                child.parentEntity,
                                child.getCenterChunk(),
                                child.wireframe,
                                child.boundingBox
                            );
                        })
                    );

                    // Enable children meshes
                    for (const child of this.children!) {
                        if (child.mesh) child.mesh.setEnabled(true);
                    }

                    // Disable current mesh to avoid overlap
                    if (this.mesh) this.mesh.setEnabled(false);
                }

                // Ensure current mesh stays disabled while children are active
                if (this.mesh) this.mesh.setEnabled(false);

                // Recurse on children
                await Promise.all(this.children!.map((child) => child.updateLOD(camera, debugMode)));
            } else {
                // We are fine at current level (or reached max level)

                if (this.mesh && this.currentLODLevel === this.level) {
                    // Mesh already up-to-date
                } else if (!this.mesh) {
                    // Mesh does not exist yet: build it (or load from precompute cache)
                    const key = this.getChunkCacheKey();
                    if (this.precomputeEnabled && ChunkTree.precomputedChunkCache.has(key)) {
                        this.mesh = await ChunkTree.precomputedChunkCache.get(key)!;
                    } else {
                        this.mesh = await this.chunkForge.worker(
                            {
                                bounds: this.bounds,
                                resolution: this.resolution,
                                radius: this.radius,
                                face: this.face,
                                level: this.level,
                                maxLevel: this.maxLevel
                            },
                            this.camera.doublepos,
                            this.parentEntity,
                            center,
                            this.wireframe,
                            this.boundingBox
                        );
                    }
                    this.currentLODLevel = this.level;
                } else {
                    // Mesh exists but considered out-of-date: rebuild and swap
                    const oldMesh = this.mesh;
                    this.meshPromise = null;

                    this.mesh = await this.chunkForge.worker(
                        {
                            bounds: this.bounds,
                            resolution: this.resolution,
                            radius: this.radius,
                            face: this.face,
                            level: this.level,
                            maxLevel: this.maxLevel
                        },
                        this.camera.doublepos,
                        this.parentEntity,
                        center,
                        this.wireframe,
                        this.boundingBox
                    );

                    this.mesh.setEnabled(true);

                    // Wait for one frame so the new mesh is rendered, then dispose old mesh
                    await new Promise<void>((resolve) => {
                        const observer = this.scene.onAfterRenderObservable.add(() => {
                            this.scene.onAfterRenderObservable.remove(observer);
                            resolve();
                        });
                    });

                    oldMesh.dispose();
                    this.currentLODLevel = this.level;
                }

                // If we were previously split, merge back by disposing children
                if (this.children) this.disposeChildren();

                // Ensure current mesh is enabled
                if (this.mesh) this.mesh.setEnabled(true);
            }
        } finally {
            this.updating = false;
        }
    }

    /**
     * Updates the debugLOD uniform on the shader material of this chunk and its children.
     */
    public updateDebugLOD(debugLOD: boolean): void {
        if (this.mesh && this.mesh.material) {
            (this.mesh.material as ShaderMaterial).setInt('debugLOD', debugLOD ? 1 : 0);
        }
        if (this.children) {
            this.children.forEach((child) => child.updateDebugLOD(debugLOD));
        }
    }
}