import { Scene, Mesh, Vector3, ShaderMaterial, TransformNode } from '@babylonjs/core';
import { ChunkForge } from './chunk_forge';
import { FloatingEntityInterface, OriginCamera } from '../../../core/camera/camera_manager';
import { Terrain } from '../../../game_objects/planets/rocky_planet/terrain';
import { Bounds, Face } from '../types';
import { globalWorkerPool } from '../workers/global_worker_pool';
import { computeSSEPx, distanceToPatchBoundingSphere, isSphereInFrustum } from './chunk_metrics';
import { createFrustumCullCache, frustumCulling } from './frustum_culling';
import { backsideCulling } from './backside_culling';

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
    resolution: number;
    children: ChunkTree[] | null;
    mesh: Mesh | null;
    face: Face;

    /** Planet anchor in WorldDouble (floating origin) */
    parentEntity: FloatingEntityInterface;

    starPosWorldDouble: Vector3 | null;

    /**
     * Parent node in Render-space that carries the planet rotation (node_Jupiter).
     * Chunks will be parented under this node to inherit rotation.
     */
    renderParent: TransformNode;

    wireframe: boolean;
    boundingBox: boolean;
    frustumCullingEnabled: boolean;
    backsideCullingEnabled: boolean;
    chunkForge: ChunkForge;

    // Guard to prevent concurrent updateLOD calls
    updating: boolean = false;

    // Keeps track of the LOD level for which the mesh was generated
    currentLODLevel: number | null = null;

    frustumCache = createFrustumCullCache();

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
     * @param resolution - Grid resolution used to generate the mesh
     * @param face - Cube face for the terrain chunk
     * @param parentEntity - FloatingEntity in WorldDouble (doublepos is planet center)
     * @param renderParent - TransformNode pivot (node_*) that carries rotation; chunks parented here
     */
    constructor(
        scene: Scene,
        camera: OriginCamera,
        bounds: Bounds,
        level: number,
        maxLevel: number,
        radius: number,
        resolution: number,
        face: Face,
        parentEntity: FloatingEntityInterface,
        renderParent: TransformNode,
        starPosWorldDouble: Vector3 | null,
        wireframe: boolean = false,
        boundingBox: boolean = false,
        frustumCullingEnabled: boolean = true,
        backsideCullingEnabled: boolean = true,
        debugLOD: boolean = false,
    ) {
        this.scene = scene;
        this.camera = camera;
        this.bounds = bounds;
        this.level = level;
        this.maxLevel = maxLevel;
        this.radius = radius;
        this.resolution = resolution;
        this.face = face;
        this.children = null;
        this.mesh = null;

        this.parentEntity = parentEntity;
        this.renderParent = renderParent;
        this.starPosWorldDouble = starPosWorldDouble;

        this.wireframe = wireframe;
        this.boundingBox = boundingBox;
        this.debugLOD = debugLOD;
        this.frustumCullingEnabled = frustumCullingEnabled;
        this.backsideCullingEnabled = backsideCullingEnabled;
        this.chunkForge = new ChunkForge(this.scene, globalWorkerPool);
    }

    /**
     * Convert a planet-local vector (relative to planet center) to WorldDouble,
     * applying the planet pivot rotation (renderParent) so culling/LOD matches the rendered terrain.
     */
    private planetLocalToWorldDouble(localPlanet: Vector3): Vector3 {
        const rotated = new Vector3();
        // TransformNormal ignores translation (we only want rotation/scale)
        Vector3.TransformNormalToRef(localPlanet, this.renderParent.getWorldMatrix(), rotated);
        return this.parentEntity.doublepos.add(rotated);
    }

    /**
     * Returns the center position of the chunk in WorldDouble.
     *
     * Uses bounds -> cube -> sphere(radius) then applies planet rotation (renderParent).
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

        // IMPORTANT: center must be on the base sphere (radius)
        const local = posCube.normalize().scale(this.radius);

        return this.planetLocalToWorldDouble(local);
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
            this.resolution,
            this.face,
            this.parentEntity,
            this.renderParent,
            this.starPosWorldDouble,
            this.wireframe,
            this.boundingBox,
            this.frustumCullingEnabled,
            this.backsideCullingEnabled,
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

    // SSE tuning knobs (adjust to taste)
    public static sseThresholdPx = 6.0; // 1..3 = very detailed, 3..6 = better perf
    public static geomErrorScale = 0.4; // empirical scale factor (depends on terrain)
    public static minDistEpsilon = 1e-3; // avoids division by zero

    /**
     * Asynchronously updates the Level of Detail (LOD) for this node.
     */
    async updateLOD(camera: OriginCamera, debugMode: boolean = false): Promise<void> {
        if (this.updating) return;
        this.updating = true;

        try {
            const { uMin, uMax, vMin, vMax } = this.bounds;

            const center = this.getCenterChunk();

            // Compute the 4 patch corner positions on the base sphere (radius only), rotated by renderParent
            const cornersUV = [
                { u: uMin, v: vMin },
                { u: uMin, v: vMax },
                { u: uMax, v: vMin },
                { u: uMax, v: vMax }
            ];

            const corners = cornersUV.map(({ u, v }) => {
                const posCube = Terrain.mapUVtoCube(u, v, this.face);
                const local = posCube.normalize().scale(this.radius);
                return this.planetLocalToWorldDouble(local);
            });

            // Bounding sphere fallback based on base sphere (no relief)
            const { radius: bsRadiusFallback } =
                distanceToPatchBoundingSphere(camera.doublepos, center, corners);

            const planetCenter = this.parentEntity.doublepos;

            // Bounds used for culling
            let centerWorld = center; // fallback
            let radiusForCull = bsRadiusFallback; // fallback

            const bi = (this.mesh as any)?.metadata?.boundsInfo;
            const hasAccurateBounds =
                Array.isArray(bi?.centerLocal) &&
                bi.centerLocal.length === 3 &&
                Number.isFinite(bi.boundingRadius);

            if (hasAccurateBounds) {
                // local planète (origine planète) -> appliquer rotation pivot -> world/double
                const centerLocal = Vector3.FromArray(bi.centerLocal);
                const rotatedLocal = new Vector3();
                Vector3.TransformNormalToRef(centerLocal, this.renderParent.getWorldMatrix(), rotatedLocal);

                centerWorld = this.parentEntity.doublepos.add(rotatedLocal);
                radiusForCull = bi.boundingRadius;
            }

            // Frustum culling (WorldDouble center; frustumCulling does WorldDouble->Render internally)
            if (this.frustumCullingEnabled && hasAccurateBounds) {
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

            // Backside culling (WorldDouble)
            if (this.backsideCullingEnabled && hasAccurateBounds) {
                const visible = backsideCulling(
                    camera.doublepos,
                    planetCenter,
                    centerWorld,
                    radiusForCull
                );

                if (!visible) {
                    this.deactivate();
                    return;
                }
            }

            // Distance for SSE consistent with radiusForCull
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

            // Split
            if (ssePx > ChunkTree.sseThresholdPx && this.level < this.maxLevel) {
                if (!this.children) {
                    this.subdivide();

                    await Promise.all(
                        this.children!.map(async (child) => {
                            child.mesh = await child.chunkForge.worker(
                                { bounds: child.bounds, resolution: child.resolution, radius: child.radius, face: child.face, level: child.level, maxLevel: child.maxLevel },
                                this.camera.doublepos,
                                child.parentEntity,
                                child.renderParent,
                                child.getCenterChunk(),
                                child.starPosWorldDouble,
                                child.wireframe,
                                child.boundingBox
                            );
                        })
                    );

                    for (const child of this.children!) {
                        if (child.mesh) child.mesh.setEnabled(true);
                    }

                    if (this.mesh) this.mesh.setEnabled(false);
                }

                if (this.mesh) this.mesh.setEnabled(false);

                await Promise.all(this.children!.map((child) => child.updateLOD(camera, debugMode)));
            } else {
                // Current LOD ok

                if (this.mesh && this.currentLODLevel === this.level) {
                    // up to date
                } else if (!this.mesh) {
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
                        this.renderParent,
                        center,
                        this.starPosWorldDouble,
                        this.wireframe,
                        this.boundingBox
                    );
                    this.currentLODLevel = this.level;
                } else {
                    const oldMesh = this.mesh;

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
                        this.renderParent,
                        center,
                        this.starPosWorldDouble,
                        this.wireframe,
                        this.boundingBox
                    );

                    this.mesh.setEnabled(true);

                    await new Promise<void>((resolve) => {
                        const observer = this.scene.onAfterRenderObservable.add(() => {
                            this.scene.onAfterRenderObservable.remove(observer);
                            resolve();
                        });
                    });

                    oldMesh.dispose();
                    this.currentLODLevel = this.level;
                }

                if (this.children) this.disposeChildren();
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

    /**
     * Priority hint for the LOD scheduler (WorldDouble).
     * Smaller = more urgent (near camera).
     */
    public estimatePriority(camera: OriginCamera): number {
        // Reprend les mêmes repères que updateLOD (WorldDouble)
        const center = this.getCenterChunk();

        // Si on a des bounds mesh précises, on améliore la distance (optionnel mais utile)
        let centerWorld = center;
        let radiusForCull = 0;

        const bi = (this.mesh as any)?.metadata?.boundsInfo;
        const hasAccurateBounds =
            Array.isArray(bi?.centerLocal) &&
            bi.centerLocal.length === 3 &&
            Number.isFinite(bi.boundingRadius);

        if (hasAccurateBounds) {
            const centerLocal = Vector3.FromArray(bi.centerLocal);
            const rotatedLocal = new Vector3();
            Vector3.TransformNormalToRef(centerLocal, this.renderParent.getWorldMatrix(), rotatedLocal);
            centerWorld = this.parentEntity.doublepos.add(rotatedLocal);
            radiusForCull = bi.boundingRadius;
        }

        const dc = Vector3.Distance(camera.doublepos, centerWorld);
        const distToPatch = Math.max(0, dc - radiusForCull);

        return distToPatch;
    }
}
