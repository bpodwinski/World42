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
    starColor: Vector3;
    starIntensity: number;

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

    public static frustumPrefetchScale = 1.25;  // 1.15–1.35 selon vitesse caméra
    public static horizonPrefetchScale = 1.15;  // idem, précharge près de l’horizon

    private pendingMeshPromise: Promise<void> | null = null;
    private pendingMeshToken = 0;
    private disposedFlag = false;

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
        starColor: Vector3,
        starIntensity: number,
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
        this.starColor = starColor;
        this.starIntensity = starIntensity;

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
            this.starColor,
            this.starIntensity,
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
        this.disposedFlag = true;
        this.pendingMeshToken++; // invalide tout résultat futur
        this.pendingMeshPromise = null;

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
    // Hystérésis: split > merge (évite split/merge en boucle)
    public static sseSplitThresholdPx = 5.0; // au-dessus: on subdivise
    public static sseMergeThresholdPx = 3.0; // en-dessous: on merge (disposer les enfants)
    public static geomErrorScale = 0.3; // empirical scale factor (depends on terrain)
    public static minDistEpsilon = 1e-3; // avoids division by zero
    public static cullReliefMargin = 0.0;

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
            let centerWorld = center; // fallback (WorldDouble)
            let radiusForCull = bsRadiusFallback + ChunkTree.cullReliefMargin; // fallback + marge relief

            const bi = (this.mesh as any)?.metadata?.boundsInfo;
            const hasAccurateBounds =
                Array.isArray(bi?.centerLocal) &&
                bi.centerLocal.length === 3 &&
                Number.isFinite(bi.boundingRadius);

            if (hasAccurateBounds) {
                // local planète -> rotation pivot -> world/double
                const centerLocal = Vector3.FromArray(bi.centerLocal);
                const rotatedLocal = new Vector3();
                Vector3.TransformNormalToRef(centerLocal, this.renderParent.getWorldMatrix(), rotatedLocal);

                centerWorld = this.parentEntity.doublepos.add(rotatedLocal);

                // boundsInfo est censé déjà inclure le relief : pas besoin de marge ici (sauf si tu veux un epsilon)
                radiusForCull = bi.boundingRadius;
            }

            let inFrustumStrict = true;
            let inFrustumPrefetch = true;

            if (this.frustumCullingEnabled) {
                inFrustumStrict = frustumCulling(
                    camera,
                    centerWorld,
                    radiusForCull,
                    isSphereInFrustum,
                    this.frustumCache
                );

                // si pas strict, test "guard band" (préfetch)
                inFrustumPrefetch = inFrustumStrict || frustumCulling(
                    camera,
                    centerWorld,
                    radiusForCull * ChunkTree.frustumPrefetchScale,
                    isSphereInFrustum,
                    this.frustumCache
                );

                // si même pas dans le guard band => on peut ignorer totalement
                if (!inFrustumPrefetch) {
                    this.deactivate();
                    return;
                }
            }

            let inHorizonStrict = true;
            let inHorizonPrefetch = true;

            if (this.backsideCullingEnabled) {
                inHorizonStrict = backsideCulling(
                    camera.doublepos,
                    planetCenter,
                    centerWorld,
                    radiusForCull
                );

                inHorizonPrefetch = inHorizonStrict || backsideCulling(
                    camera.doublepos,
                    planetCenter,
                    centerWorld,
                    radiusForCull * ChunkTree.horizonPrefetchScale
                );

                if (!inHorizonPrefetch) {
                    this.deactivate();
                    return;
                }
            }

            // IMPORTANT: affichage strict uniquement
            const shouldDrawStrict =
                (!this.frustumCullingEnabled || inFrustumStrict) &&
                (!this.backsideCullingEnabled || inHorizonStrict);

            // Si on est en prefetch mais pas en strict: on précharge le mesh courant, sans raffiner
            if (!shouldDrawStrict) {
                this.requestMeshIfNeeded(centerWorld);
                this.deactivate(); // ne rien afficher tant que ce n'est pas strict
                return;
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
            const splitTh = ChunkTree.sseSplitThresholdPx;
            const mergeTh = ChunkTree.sseMergeThresholdPx;

            const shouldSplit = (ssePx > splitTh) && (this.level < this.maxLevel);
            const shouldMerge = (ssePx < mergeTh);

            // Si:
            // - on doit splitter, OU
            // - on est déjà split et on n’est pas sous le seuil de merge
            // => on garde/active les enfants (on ne merge pas dans la zone d’hystérésis)
            if (shouldSplit || (this.children && !shouldMerge)) {
                // 1) Assure au moins un mesh parent (fallback) avant de splitter plus
                if (!this.mesh) {
                    this.requestMeshIfNeeded(centerWorld);
                    return;
                }

                // 2) Create children if needed
                if (!this.children) this.subdivide();
                const children = this.children;
                if (!children) return;

                // 3) Demande les meshes enfants (une fois)
                for (const child of children) {
                    child.requestMeshIfNeeded(child.getCenterChunk());
                }

                const childrenReady = children.every((c) => !!c.mesh && c.currentLODLevel === c.level);

                // 4) Tant que les enfants ne sont pas prêts: on garde le parent visible et on STOP ici
                if (!childrenReady) {
                    if (this.mesh) this.mesh.setEnabled(shouldDrawStrict); // parent couvre
                    return;
                }

                // 5) Enfants prêts: on coupe le parent et on descend
                if (this.mesh) this.mesh.setEnabled(false);

                for (const child of children) {
                    await child.updateLOD(camera, debugMode);
                }

                return;
            }
            else {
                // Leaf path (on garde ce node comme feuille)
                if (this.mesh && this.currentLODLevel === this.level) {
                    // up to date
                } else if (!this.mesh) {
                    this.requestMeshIfNeeded(centerWorld);
                } else {
                    this.requestMeshIfNeeded(centerWorld);
                    if (this.mesh) this.mesh.setEnabled(shouldDrawStrict);
                }

                // Merge uniquement si on est VRAIMENT sous mergeTh
                if (this.children && shouldMerge) this.disposeChildren();
                if (this.mesh) this.mesh.setEnabled(shouldDrawStrict);
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

    private requestMeshIfNeeded(patchCenterWorldDouble: Vector3): void {
        if (this.disposedFlag) return;

        // Mesh déjà OK
        if (this.mesh && this.currentLODLevel === this.level) return;

        // Déjà en cours
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

        this.pendingMeshPromise = this.chunkForge.worker(
            params,
            this.camera.doublepos,
            this.parentEntity,
            this.renderParent,
            patchCenterWorldDouble,
            this.starPosWorldDouble,
            this.starColor,
            this.starIntensity,
            this.wireframe,
            this.boundingBox
        ).then((mesh) => {
            // Résultat arrivé trop tard (node mergé/disposé) => on jette
            if (this.disposedFlag || token !== this.pendingMeshToken) {
                mesh.dispose();
                return;
            }

            // Remplace l'ancien mesh si besoin
            if (this.mesh && this.mesh !== mesh) {
                this.mesh.dispose();
            }

            this.mesh = mesh;
            this.mesh.setEnabled(false); // affichage décidé dans updateLOD
            this.currentLODLevel = this.level;
        }).catch((e) => {
            // Optionnel: log
            console.error("[ChunkTree] mesh build failed", e);
        }).finally(() => {
            // Libère le slot pending seulement si c'est toujours le job courant
            if (token === this.pendingMeshToken) {
                this.pendingMeshPromise = null;
            }
        });
    }
}
