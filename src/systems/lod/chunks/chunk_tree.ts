import {
    Scene,
    Mesh,
    Vector3,
    ShaderMaterial,
    MeshBuilder,
    StandardMaterial,
    Color3
} from '@babylonjs/core';
import { ChunkForge } from './chunk_forge';
import { DeleteSemaphore } from '../workers/delete_semaphore';
import { io, Socket } from 'socket.io-client';
import { FloatingEntityInterface, OriginCamera } from '../../../core/camera/camera_manager';
import { Terrain } from '../../../game_objects/planets/rocky_planet/terrain';
import { WorkerPool } from '../workers/worker_pool';

//const socket: Socket = io("***:8888");

/**
 * Type defining the UV bounds of a terrain chunk
 */
export type Bounds = {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
};

/**
 * Type defining the possible cube faces
 */
export type Face = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/**
 * Global worker pool for mesh chunk computation
 *
 * Instantiated with the worker script URL and using hardware concurrency
 * for both workers and concurrent tasks.
 */
export const globalWorkerPool = new WorkerPool(
    new URL('../workers/terrain_mesh_worker', import.meta.url).href,
    navigator.hardwareConcurrency - 1,
    navigator.hardwareConcurrency - 1,
    true
);

/**
 * Global cache to store precomputed meshes (optional)
 */
const precomputedChunkCache = new Map<string, Promise<Mesh>>();

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

    private chunkForge: ChunkForge;

    // Cache for asynchronous mesh creation to avoid duplicate generation
    private meshPromise: Promise<Mesh> | null = null;

    // Guard to prevent concurrent updateLOD calls
    private updating: boolean = false;

    // Keeps track of the LOD level for which the mesh was generated
    private currentLODLevel: number | null = null;

    // Flag to enable/disable precompute caching
    private precomputeEnabled: boolean = false;

    // Debug mode flag (passed to the shader)
    public debugLOD: boolean;
    public static debugLODEnabled: boolean = false;

    /**
     * Bounding sphere debug rendering
     *  - Set ChunkTree.showBoundingSpheres = true to display
     *  - Each node will draw a wireframe sphere of its current bounding sphere
     */
    public static showBoundingSpheres: boolean = false;
    private debugBoundingSphereMesh: Mesh | null = null;

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
        precomputeEnabled: boolean,
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
        this.debugLOD = debugLOD;
        this.precomputeEnabled = precomputeEnabled;
        this.chunkForge = new ChunkForge(this.scene, globalWorkerPool);
    }

    /**
     * Returns the center position of the chunk in world space.
     *
     * Uses bounds + parentEntity.doublepos to compute a point on the quadsphere at planet radius.
     */
    private getCenterChunk(): Vector3 {
        const { uMin, uMax, vMin, vMax } = this.bounds;
        const uCenter = (uMin + uMax) / 2;
        const vCenter = (vMin + vMax) / 2;
        const posCube = Terrain.mapUVtoCube(uCenter, vCenter, this.face);

        return this.parentEntity.doublepos.add(posCube.normalize().scale(this.radius));
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
        if (precomputedChunkCache.has(key)) {
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
            center
        );

        precomputedChunkCache.set(key, meshPromise);

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
            this.precomputeEnabled,
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
        if (this.debugBoundingSphereMesh) this.debugBoundingSphereMesh.setEnabled(false);
        if (this.children) this.children.forEach((child) => child.deactivate());
    }

    /**
     * Disposes the current node mesh and recursively disposes its children.
     */
    dispose(): void {
        if (this.debugBoundingSphereMesh) {
            this.debugBoundingSphereMesh.dispose();
            this.debugBoundingSphereMesh = null;
        }
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
    public static sseThresholdPx = 6.0;   // 1..3 = very detailed, 3..6 = better perf
    public static geomErrorScale = 0.6;   // empirical scale factor (depends on terrain)
    public static minDistEpsilon = 1e-3;  // avoids division by zero

    /**
     * Estimates patch world size from its 4 corner positions.
     * We use the maximum edge/diagonal length as a conservative proxy for patch diameter.
     */
    private estimatePatchWorldSize(corners: Vector3[]): number {
        let max2 = 0;

        const pairs: [number, number][] = [
            [0, 1], [0, 2], [1, 3], [2, 3], // edges
            [0, 3], [1, 2],                 // diagonals
        ];

        for (const [a, b] of pairs) {
            const dx = corners[b].x - corners[a].x;
            const dy = corners[b].y - corners[a].y;
            const dz = corners[b].z - corners[a].z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > max2) max2 = d2;
        }

        return Math.sqrt(max2);
    }

    /**
     * Creates/updates a wireframe sphere representing this chunk bounding sphere.
     * Safe to call every frame while debugging.
     */
    private updateBoundingSphereDebug(center: Vector3, radius: number): void {
        if (!ChunkTree.showBoundingSpheres) {
            if (this.debugBoundingSphereMesh) this.debugBoundingSphereMesh.setEnabled(false);
            return;
        }

        if (!this.debugBoundingSphereMesh) {
            const name = `dbg_bs_${this.face}_${this.level}_${Math.random().toString(36).slice(2)}`;

            this.debugBoundingSphereMesh = MeshBuilder.CreateSphere(
                name,
                { diameter: 2 * radius, segments: 12 },
                this.scene
            );

            const mat = new StandardMaterial(`${name}_mat`, this.scene);
            mat.wireframe = true;
            mat.emissiveColor = new Color3(0, 1, 0);
            mat.disableLighting = true;

            this.debugBoundingSphereMesh.material = mat;
            this.debugBoundingSphereMesh.isPickable = false;
            this.debugBoundingSphereMesh.alwaysSelectAsActiveMesh = true;
        } else {
            // Rescale existing unit sphere to the exact radius (cheap, avoids rebuild)
            const current = this.debugBoundingSphereMesh.getBoundingInfo().boundingSphere.radius;
            const scale = current > 0 ? radius / current : 1;
            this.debugBoundingSphereMesh.scaling.set(scale, scale, scale);
        }

        this.debugBoundingSphereMesh.position.copyFrom(center);
        this.debugBoundingSphereMesh.setEnabled(true);
    }

    /**
     * Computes camera-to-patch distance using a bounding sphere.
     *
     * distance = max(0, distance(camera, sphereCenter) - sphereRadius)
     *
     * - sphereCenter: patch center
     * - sphereRadius: max distance from center to corners (conservative)
     *
     * This is more stable than using min(center/corners distance), especially near grazing angles.
     *
     * Returns both distance and radius (radius is useful for debug rendering).
     */
    private distanceToPatchBoundingSphere(
        camPos: Vector3,
        patchCenter: Vector3,
        corners: Vector3[]
    ): { distance: number; radius: number } {
        let r2 = 0;
        for (const c of corners) {
            const dx = c.x - patchCenter.x;
            const dy = c.y - patchCenter.y;
            const dz = c.z - patchCenter.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r2) r2 = d2;
        }
        const sphereRadius = Math.sqrt(r2);

        const dc = Vector3.Distance(camPos, patchCenter);
        const distance = Math.max(0, dc - sphereRadius);

        return { distance, radius: sphereRadius };
    }

    /**
     * Computes Screen-Space Error (SSE) in pixels.
     *
     * SSE_px ≈ (geometricError / distanceToPatch) * K
     * where K = viewportHeight / (2 * tan(fov/2))
     *
     * geometricError is approximated from patch size and mesh resolution.
     */
    private computeSSEPx(
        camera: OriginCamera,
        distanceToPatch: number,
        corners: Vector3[]
    ): number {
        const engine = this.scene.getEngine();
        const viewportH = engine.getRenderHeight(true);

        // Projection factor (pixels per world-unit at distance 1)
        const K = viewportH / (2 * Math.tan(camera.fov * 0.5));

        // Approximate geometric error: patch diameter / grid resolution (scaled empirically)
        const patchSize = this.estimatePatchWorldSize(corners);
        const geometricError = (patchSize / this.resolution) * ChunkTree.geomErrorScale;

        const d = Math.max(distanceToPatch, ChunkTree.minDistEpsilon);
        return (geometricError / d) * K;
    }

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
                return this.parentEntity.doublepos.add(posCube.normalize().scale(this.radius));
            });

            // Use bounding sphere distance instead of "min distance to center/corners"
            const { distance: distanceToPatch, radius: bsRadius } =
                this.distanceToPatchBoundingSphere(camera.doublepos, center, corners);

            // Debug: draw bounding sphere (wireframe)
            const centerRS = this.camera.toRenderSpace(center);
            this.updateBoundingSphereDebug(centerRS, bsRadius);

            // SSE decision in pixels
            const ssePx = this.computeSSEPx(camera, distanceToPatch, corners);

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
                                child.getCenterChunk()
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
                    if (this.precomputeEnabled && precomputedChunkCache.has(key)) {
                        this.mesh = await precomputedChunkCache.get(key)!;
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
                            center
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
                        center
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
