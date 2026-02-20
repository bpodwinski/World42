import { Matrix, Mesh, Plane, Scene, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import type { TerrainShadowContext } from "../../../game_objects/planets/rocky_planet/terrains_shader";
import type { FloatingEntityInterface, OriginCamera } from "../../../core/camera/camera_manager";
import type { Bounds, Face } from "../types";
import { globalWorkerPool } from "../workers/global_worker_pool";
import { ChunkForge } from "./chunk_forge";
import { buildBaseGeometry, localToWorldDouble, type ChunkBaseGeometry } from "./chunk_geometry";
import { computeSSEFactor, distanceToPatchBoundingSphere } from "./chunk_metrics";
import { evalChunkCulling } from "./chunk_culling_eval";
import { evalLodDecision } from "./chunk_lod_eval";

/**
 * One quadtree node (one terrain patch).
 *
 * Coordinate spaces used in this class:
 * - WorldDouble: `camera.doublepos`, `parentEntity.doublepos`, `starPosWorldDouble`
 * - Planet-local: worker-generated vertices + `baseGeom` (center/corners on base sphere)
 * - Render-space: frustum checks via `centerRender = centerWorldDouble - camWorldDouble`
 */
export class ChunkTree {
    /** Babylon scene used for mesh/material creation and rendering. */
    scene: Scene;

    /** Origin camera used for LOD and culling computations. */
    camera: OriginCamera;

    /** Patch UV bounds (tan(angle) space). */
    bounds: Bounds;

    /** Current quadtree level (0 = root). */
    level: number;

    /** Maximum quadtree level allowed. */
    maxLevel: number;

    /** Planet radius in simulation units. */
    radius: number;

    /** Grid resolution for generated terrain meshes. */
    resolution: number;

    /** Children nodes (4 quadrants) or null if leaf. */
    children: ChunkTree[] | null;

    /** Babylon mesh for this patch (generated asynchronously) or null if missing. */
    mesh: Mesh | null;

    /** Cube face to which this patch belongs. */
    face: Face;

    /**
     * Cached frustum planes used by `camera.getFrustumPlanesToRef`.
     * Babylon expects an array of 6 pre-allocated Plane objects.
     */
    private _frustumPlanes: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));

    /** Planet anchor in WorldDouble (planet center). */
    parentEntity: FloatingEntityInterface;

    /** Star position in WorldDouble (nullable if no star). */
    starPosWorldDouble: Vector3 | null;

    /** Star light color (linear RGB). */
    starColor: Vector3;

    /** Star light intensity scalar. */
    starIntensity: number;

    /**
     * Render-space pivot carrying the planet rotation (e.g. `node_Jupiter`).
     * Terrain meshes are parented under this node to inherit rotation.
     */
    renderParent: TransformNode;

    /** Enable wireframe rendering on generated chunk materials. */
    wireframe: boolean;

    /** Enable Babylon bounding box display for debugging. */
    boundingBox: boolean;

    /** Enable/disable frustum culling. */
    frustumCullingEnabled: boolean;

    /** Enable/disable horizon/backside culling. */
    backsideCullingEnabled: boolean;

    /**
     * Shared chunk forge used to build meshes via the worker pool.
     * Do not allocate one forge per node.
     */
    chunkForge: ChunkForge;

    /** Guard to prevent concurrent `updateLOD()` calls on the same node. */
    updating = false;

    /** LOD level for which `mesh` was generated (null if no mesh). */
    currentLODLevel: number | null = null;

    /** Instance-level debug flag (forwarded to shader). */
    public debugLOD: boolean;

    /** Global debug flag toggled externally (forwarded to shader). */
    public static debugLODEnabled = false;

    /** Frustum guard-band scale for prefetching (tune for camera speed). */
    public static frustumPrefetchScale = 1.2;

    /** Horizon guard-band scale for prefetching (tune for camera speed). */
    public static horizonPrefetchScale = 1.1;

    /** Promise tracking an in-flight mesh request (null if none). */
    private pendingMeshPromise: Promise<void> | null = null;

    /** Token to invalidate stale mesh completions when node is disposed/merged. */
    private pendingMeshToken = 0;

    /** Set to true once disposed; ignores any future async results. */
    private disposedFlag = false;

    /** Cached base geometry in planet-local space (computed once). */
    private baseGeom: ChunkBaseGeometry;

    /** Cached world geometry (recomputed during `updateLOD`, no allocations). */
    private _centerWorldBase = new Vector3();

    /** Cached base-sphere corners in WorldDouble (recomputed during `updateLOD`, no allocations). */
    private _cornersWorldBase: [Vector3, Vector3, Vector3, Vector3] = [
        new Vector3(),
        new Vector3(),
        new Vector3(),
        new Vector3(),
    ];

    /** Temporary center used when accurate relief-aware bounds are available. */
    private _centerForCull = new Vector3();

    /** Temporary center in render-space used by frustum checks. */
    private _centerRenderTmp = new Vector3();

    /** Temporary rotated vector for local->world conversion. */
    private _tmpRot = new Vector3();

    /** Temporary local vector for decoding metadata bounds. */
    private _tmpLocal = new Vector3();

    /**
     * Cached SSE factor K for this node.
     * Ideally computed once per frame by the scheduler, but cached here as fallback.
     */
    private _lastSseK = 0;

    /** Split threshold in pixels (above => split). */
    public static sseSplitThresholdPx = 5.0;

    /** Merge threshold in pixels (below => merge). */
    public static sseMergeThresholdPx = 4.0;

    /** Empirical scale factor applied to geometric error. */
    public static geomErrorScale = 0.5;

    /** Minimum distance epsilon to avoid division by zero. */
    public static minDistEpsilon = 1e-3;

    /** Optional margin to expand culling radius to account for relief (fallback bounds only). */
    public static cullReliefMargin = 0.0;

    /**
     * Create a new quadtree node.
     *
     * @param scene Babylon scene used for mesh/material creation.
     * @param camera Origin camera used for LOD and culling.
     * @param bounds Patch UV bounds in tan(angle) space.
     * @param level Current quadtree level.
     * @param maxLevel Maximum quadtree level.
     * @param radius Planet radius (simulation units).
     * @param resolution Mesh grid resolution.
     * @param face Cube face.
     * @param parentEntity Planet floating entity (WorldDouble center).
     * @param renderParent Pivot node carrying planet rotation.
     * @param starPosWorldDouble Star position in WorldDouble (nullable).
     * @param starColor Star light color.
     * @param starIntensity Star light intensity.
     * @param wireframe Wireframe rendering toggle.
     * @param boundingBox Bounding box rendering toggle.
     * @param frustumCullingEnabled Enable frustum culling.
     * @param backsideCullingEnabled Enable horizon/backside culling.
     * @param debugLOD Debug flag forwarded to shader.
     * @param chunkForge Optional shared forge instance (recommended).
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
        starColor: Vector3,
        starIntensity: number,
        wireframe = false,
        boundingBox = false,
        frustumCullingEnabled = true,
        backsideCullingEnabled = true,
        debugLOD = false,
        chunkForge?: ChunkForge
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
        this.starColor = starColor;
        this.starIntensity = starIntensity;

        this.wireframe = wireframe;
        this.boundingBox = boundingBox;
        this.debugLOD = debugLOD;
        this.frustumCullingEnabled = frustumCullingEnabled;
        this.backsideCullingEnabled = backsideCullingEnabled;

        // Shared forge (root should pass one; otherwise the root creates it once).
        this.chunkForge = chunkForge ?? new ChunkForge(this.scene, globalWorkerPool);

        // Precompute planet-local base geometry once (no trig in the hot path).
        this.baseGeom = buildBaseGeometry(this.bounds, this.face, this.radius);
    }

    /**
     * Create a child node sharing the same configuration and forge.
     *
     * @param bounds Child patch bounds.
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
            this.starColor,
            this.starIntensity,
            this.wireframe,
            this.boundingBox,
            this.frustumCullingEnabled,
            this.backsideCullingEnabled,
            this.debugLOD,
            this.chunkForge
        );
    }

    /**
     * Split this node into 4 children using angle-space midpoints (atan/tan).
     */
    subdivide(): void {
        this.children = [];
        const { uMin, uMax, vMin, vMax } = this.bounds;

        const uMid = Math.tan((Math.atan(uMin) + Math.atan(uMax)) * 0.5);
        const vMid = Math.tan((Math.atan(vMin) + Math.atan(vMax)) * 0.5);

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
     * Dispose all children recursively and clear the children list.
     */
    disposeChildren(): void {
        if (!this.children) return;
        this.children.forEach((c) => c.dispose());
        this.children = null;
    }

    /**
     * Apply main-pass and shadow-caster states to this node and descendants.
     */
    private setOwnRenderState(mainPassEnabled: boolean, shadowCasterEnabled: boolean): void {
        if (!this.mesh) return;
        const keepEnabled = mainPassEnabled || shadowCasterEnabled;
        this.mesh.setEnabled(keepEnabled);
        this.mesh.isVisible = mainPassEnabled;
    }

    private setRenderStates(mainPassEnabled: boolean, shadowCasterEnabled: boolean): void {
        this.setOwnRenderState(mainPassEnabled, shadowCasterEnabled);
        this.children?.forEach((c) => c.setRenderStates(mainPassEnabled, shadowCasterEnabled));
    }

    /**
     * Disable this node's mesh and all descendant meshes.
     * Does not dispose resources.
     */
    deactivate(): void {
        this.setRenderStates(false, false);
    }

    /**
     * Dispose this node's mesh and all descendants.
     * Invalidates any pending async mesh build results.
     */
    dispose(): void {
        this.disposedFlag = true;
        this.pendingMeshToken++;
        this.pendingMeshPromise = null;

        if (this.mesh) {
            this.mesh.dispose();
            this.mesh = null;
        }
        if (this.children) {
            this.children.forEach((c) => c.dispose());
            this.children = null;
        }
    }

    /**
     * Update cached center/corners on the base sphere in WorldDouble.
     * No allocations; relies on precomputed planet-local base geometry.
     */
    private updateWorldBaseGeometry(): void {
        const planetCenter = this.parentEntity.doublepos;
        const wm = this.renderParent.getWorldMatrix();

        localToWorldDouble(this.baseGeom.centerLocal, wm, planetCenter, this._centerWorldBase);
        localToWorldDouble(this.baseGeom.cornersLocal[0], wm, planetCenter, this._cornersWorldBase[0]);
        localToWorldDouble(this.baseGeom.cornersLocal[1], wm, planetCenter, this._cornersWorldBase[1]);
        localToWorldDouble(this.baseGeom.cornersLocal[2], wm, planetCenter, this._cornersWorldBase[2]);
        localToWorldDouble(this.baseGeom.cornersLocal[3], wm, planetCenter, this._cornersWorldBase[3]);
    }

    /**
     * Compute culling bounds in WorldDouble:
     * - fallback: base-sphere bounding radius from cached corners (no relief)
     * - accurate: optional relief-aware bounds from mesh metadata (`boundsInfo`)
     *
     * @param camWorldDouble Camera position in WorldDouble.
     */
    private computeCullBounds(camWorldDouble: Vector3): { centerWorld: Vector3; radiusForCull: number } {
        this.updateWorldBaseGeometry();

        const { radius: bsRadiusFallback } = distanceToPatchBoundingSphere(
            camWorldDouble,
            this._centerWorldBase,
            this._cornersWorldBase
        );

        let centerWorld = this._centerWorldBase;
        let radiusForCull = bsRadiusFallback + ChunkTree.cullReliefMargin;

        const bi = (this.mesh as any)?.metadata?.boundsInfo;
        const hasAccurateBounds =
            Array.isArray(bi?.centerLocal) &&
            bi.centerLocal.length === 3 &&
            Number.isFinite(bi.boundingRadius);

        if (hasAccurateBounds) {
            // Convert centerLocal (planet-local) -> rotated -> WorldDouble.
            Vector3.FromArrayToRef(bi.centerLocal, 0, this._tmpLocal);
            Vector3.TransformNormalToRef(this._tmpLocal, this.renderParent.getWorldMatrix(), this._tmpRot);
            this._centerForCull.copyFrom(this.parentEntity.doublepos).addInPlace(this._tmpRot);

            centerWorld = this._centerForCull;
            radiusForCull = bi.boundingRadius;
        }

        return { centerWorld, radiusForCull };
    }

    /**
     * Decide if a non-visible chunk should still stay active as a shadow caster.
     *
     * Uses a first-pass heuristic: cast a segment from chunk center along `-lightDirection`
     * and test it against an enlarged frustum sphere around the camera.
     */
    private shouldKeepAsShadowCaster(camWorldDouble: Vector3, centerWorld: Vector3, radiusForCull: number): boolean {
        const shadowCtx = (this.scene.metadata as any)?.terrainShadow as TerrainShadowContext | null | undefined;
        if (!shadowCtx) return false;

        const lightDir = shadowCtx.lightDirection;
        const shadowRange = shadowCtx.shadowRange;
        if (!lightDir || !Number.isFinite(shadowRange) || shadowRange <= 0) return false;

        const lightLenSq = lightDir.lengthSquared();
        if (!Number.isFinite(lightLenSq) || lightLenSq < 1e-12) return false;

        const invLightLen = 1.0 / Math.sqrt(lightLenSq);
        const segLen = shadowRange * 2.0;

        const ax = centerWorld.x;
        const ay = centerWorld.y;
        const az = centerWorld.z;

        const bx = ax - lightDir.x * invLightLen * segLen;
        const by = ay - lightDir.y * invLightLen * segLen;
        const bz = az - lightDir.z * invLightLen * segLen;

        const abx = bx - ax;
        const aby = by - ay;
        const abz = bz - az;
        const apx = camWorldDouble.x - ax;
        const apy = camWorldDouble.y - ay;
        const apz = camWorldDouble.z - az;

        const abLenSq = abx * abx + aby * aby + abz * abz;
        if (abLenSq <= 1e-12) return false;

        const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / abLenSq));
        const qx = ax + abx * t;
        const qy = ay + aby * t;
        const qz = az + abz * t;

        const dx = camWorldDouble.x - qx;
        const dy = camWorldDouble.y - qy;
        const dz = camWorldDouble.z - qz;
        const distSq = dx * dx + dy * dy + dz * dz;

        const guardBandScale = ChunkTree.frustumPrefetchScale;
        const frustumSphereRadius = shadowRange * guardBandScale;
        const threshold = frustumSphereRadius + radiusForCull;

        return distSq <= threshold * threshold;
    }

    /**
     * Update LOD state for this node and optionally recurse into children.
     *
     * @param camera Origin camera.
     * @param debugMode Optional debug flag (currently unused; kept for compatibility).
     * @param deadlineMs Absolute timestamp (performance.now()) beyond which recursion is
     *   stopped early to respect the frame budget. Defaults to Infinity (no limit).
     */
    async updateLOD(camera: OriginCamera, debugMode = false, deadlineMs = Infinity): Promise<void> {
        // Bail out immediately if the frame budget is already exceeded.
        if (performance.now() >= deadlineMs) return;

        if (this.updating) return;
        this.updating = true;

        try {
            const camWorldDouble = camera.doublepos;
            const planetCenter = this.parentEntity.doublepos;

            const { centerWorld, radiusForCull } = this.computeCullBounds(camWorldDouble);

            // Babylon requires 6 pre-allocated planes (never pass an array with undefined entries).
            camera.getFrustumPlanesToRef(this._frustumPlanes);

            const cull = evalChunkCulling({
                camera,
                frustumPlanes: this._frustumPlanes,
                camWorldDouble,
                planetCenterWorldDouble: planetCenter,
                centerWorldDouble: centerWorld,
                radiusForCull,
                frustumEnabled: this.frustumCullingEnabled,
                backsideEnabled: this.backsideCullingEnabled,
                frustumPrefetchScale: ChunkTree.frustumPrefetchScale,
                horizonPrefetchScale: ChunkTree.horizonPrefetchScale,
                centerRenderTmp: this._centerRenderTmp,
            });

            const castsShadowToView = this.shouldKeepAsShadowCaster(camWorldDouble, centerWorld, radiusForCull);

            if (!cull.inPrefetch) {
                this.setRenderStates(false, false);
                return;
            }

            if (!cull.drawStrict) {
                this.requestMeshIfNeeded(camWorldDouble, centerWorld);
                this.setRenderStates(false, castsShadowToView);
                return;
            }

            // SSE factor K (fallback cache per node; ideally computed once per frame by the scheduler).
            if (!this._lastSseK) this._lastSseK = computeSSEFactor(this.scene, camera.fov);

            const dc = Vector3.Distance(camWorldDouble, centerWorld);
            const distanceToPatch = Math.max(0, dc - radiusForCull);

            const { shouldSplit, shouldMerge } = evalLodDecision({
                cornersWorld: this._cornersWorldBase,
                distanceToPatch,
                resolution: this.resolution,
                level: this.level,
                maxLevel: this.maxLevel,
                splitTh: ChunkTree.sseSplitThresholdPx,
                mergeTh: ChunkTree.sseMergeThresholdPx,
                geomErrorScale: ChunkTree.geomErrorScale,
                minDistEpsilon: ChunkTree.minDistEpsilon,
                sseK: this._lastSseK,
            });

            // Split path (hysteresis preserved).
            if (shouldSplit || (this.children && !shouldMerge)) {
                // Ensure parent mesh exists as a fallback before going deeper.
                if (!this.mesh) {
                    this.requestMeshIfNeeded(camWorldDouble, centerWorld);
                    return;
                }

                if (!this.children) this.subdivide();
                const children = this.children!;

                for (const child of children) {
                    child.requestMeshIfNeeded(camWorldDouble, child.getCenterWorldDouble());
                }

                const childrenReady = children.every((c) => !!c.mesh && c.currentLODLevel === c.level);

                if (!childrenReady) {
                    // Keep transition one-sided while children are still warming up:
                    // parent visible, children hidden (avoids parent/child overlap).
                    for (const child of children) child.setRenderStates(false, false);
                    this.setOwnRenderState(true, true);
                    return;
                }

                // Keep parent visible until all children were actually processed this frame.
                // This avoids transient holes/clipping when the frame budget is exhausted
                // in the middle of a split transition.
                let processedAllChildren = true;
                for (const child of children) {
                    // Stop recursing if the frame budget is exhausted.
                    if (performance.now() >= deadlineMs) {
                        processedAllChildren = false;
                        break;
                    }
                    await child.updateLOD(camera, debugMode, deadlineMs);
                }

                if (!processedAllChildren) {
                    // If frame budget was hit mid-split, roll back to parent-only
                    // for this frame to avoid parent+child superposition.
                    for (const child of children) child.setRenderStates(false, false);
                    this.setOwnRenderState(true, true);
                    return;
                }

                this.setOwnRenderState(false, false);
                return;
            }

            // Leaf path.
            if (!this.mesh || this.currentLODLevel !== this.level) {
                this.requestMeshIfNeeded(camWorldDouble, centerWorld);
            }

            if (this.children && shouldMerge) this.disposeChildren();
            this.setRenderStates(true, true);
        } finally {
            this.updating = false;
        }
    }

    /**
     * Get the patch center in WorldDouble on the base sphere (no trig).
     * Ensures world base geometry is up-to-date (planet pivot rotation may change).
     */
    private getCenterWorldDouble(): Vector3 {
        this.updateWorldBaseGeometry();
        return this._centerWorldBase;
    }

    /**
     * Update the `debugLOD` uniform on this chunk material and descendants.
     *
     * @param debugLOD Enable/disable debug LOD shading.
     */
    public updateDebugLOD(debugLOD: boolean): void {
        const mat = this.mesh?.material;
        if (mat instanceof ShaderMaterial) {
            mat.setInt("debugLOD", debugLOD ? 1 : 0);
        }
        this.children?.forEach((c) => c.updateDebugLOD(debugLOD));
    }

    /**
     * Priority hint for the scheduler (smaller = more urgent).
     * Uses WorldDouble distance-to-patch based on culling radius.
     */
    public estimatePriority(camera: OriginCamera): number {
        const camWorldDouble = camera.doublepos;
        const { centerWorld, radiusForCull } = this.computeCullBounds(camWorldDouble);
        const dc = Vector3.Distance(camWorldDouble, centerWorld);
        return Math.max(0, dc - radiusForCull);
    }

    /**
     * Request mesh generation if missing or stale for the current LOD level.
     *
     * @param camWorldDouble Camera position in WorldDouble (used for worker priority).
     * @param patchCenterWorldDouble Patch center in WorldDouble (used for worker priority/build context).
     */
    private requestMeshIfNeeded(camWorldDouble: Vector3, patchCenterWorldDouble: Vector3): void {
        if (this.disposedFlag) return;
        if (this.mesh && this.currentLODLevel === this.level) return;
        if (this.pendingMeshPromise) return;

        const token = ++this.pendingMeshToken;

        const params = {
            bounds: this.bounds,
            resolution: this.resolution,
            radius: this.radius,
            face: this.face,
            level: this.level,
            maxLevel: this.maxLevel,
        };

        this.pendingMeshPromise = this.chunkForge
            .worker(
                params,
                camWorldDouble,
                this.parentEntity,
                this.renderParent,
                patchCenterWorldDouble,
                this.starPosWorldDouble,
                this.starColor,
                this.starIntensity,
                this.wireframe,
                this.boundingBox
            )
            .then((mesh) => {
                if (this.disposedFlag || token !== this.pendingMeshToken) {
                    mesh.dispose();
                    return;
                }
                if (this.mesh && this.mesh !== mesh) this.mesh.dispose();

                this.mesh = mesh;
                this.mesh.setEnabled(false);
                this.mesh.isVisible = false;
                this.currentLODLevel = this.level;
            })
            .catch((e) => {
                console.error("[ChunkTree] mesh build failed", e);
            })
            .finally(() => {
                if (token === this.pendingMeshToken) this.pendingMeshPromise = null;
            });
    }
}
