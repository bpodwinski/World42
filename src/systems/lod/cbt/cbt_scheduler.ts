import {
    Color3,
    DirectionalLight,
    Frustum,
    Matrix,
    Mesh,
    Observer,
    Plane,
    Scene,
    StandardMaterial,
    TransformNode,
    Vector3,
    VertexData,
} from '@babylonjs/core';
import type {
    FloatingEntityInterface,
    OriginCamera,
} from '../../../core/camera/camera_manager';
import { classifyLeaves } from './cbt_classify';
import { CbtEmitCache, emitMeshFromLeaves } from './cbt_emit';
import { CbtState } from './cbt_state';

export type CbtPlanetOptions = {
    key: string;
    entity: FloatingEntityInterface;
    renderParent: TransformNode;
    radiusSim: number;
    maxDepth: number;
    maxSplitsPerFrame: number;
    maxMergesPerFrame?: number;
    splitThresholdPx2: number;
    splitHysteresis: number;
    starPosWorldDouble: Vector3 | null;
    starColor: Vector3;
    starIntensity: number;
    /** Enable backside culling of split candidates (default true). */
    cullBackface?: boolean;
    /** Guard-band cosine threshold for the backside cull (default -0.05). */
    cullMinDot?: number;
    /** Use the incremental (per-slot cached) mesh emitter (default true). */
    incrementalMesh?: boolean;
    /** Frustum guard band as a multiple of triangle bound radius (default 1). */
    frustumGuardScale?: number;
};

/** Per-planet telemetry, refreshed on each {@link CbtPlanet.update}. */
export type CbtStats = {
    /** Current leaf (triangle) count. */
    leafCount: number;
    /** Splits applied during the last update. */
    splitsThisFrame: number;
    /** Merges applied during the last update. */
    mergesThisFrame: number;
    /** Wall-clock ms for the classify (measure + split-candidate) section. */
    classifyMs: number;
    /** Wall-clock ms for the last mesh rebuild (0 if no rebuild occurred). */
    rebuildMs: number;
    /** Vertex count of the most recently emitted mesh. */
    lastVertexCount: number;
};

/** Minimal per-planet geometry for deterministic headless capture. */
export type CbtPlanetInfo = {
    key: string;
    /** Planet center in WorldDouble (sim units). */
    center: [number, number, number];
    radiusSim: number;
};

/** Scene-wide CBT telemetry aggregated across all planets. */
export type CbtAggregateStats = {
    planetCount: number;
    leafCount: number;
    splitsThisFrame: number;
    mergesThisFrame: number;
    /** Worst-case classify ms across planets (the frame-budget pressure point). */
    classifyMs: number;
    /** Worst-case rebuild ms across planets. */
    rebuildMs: number;
    vertexCount: number;
};

export class CbtPlanet {
    readonly key: string;
    readonly entity: FloatingEntityInterface;
    readonly radiusSim: number;
    readonly starPosWorldDouble: Vector3 | null;

    private mesh: Mesh | null = null;
    private material: StandardMaterial | null = null;
    private sunLight: DirectionalLight | null = null;
    private state: CbtState;
    private pendingFullRefresh = true;
    private shadowAttached = false;
    private debugLod = false;
    private readonly stats: CbtStats = {
        leafCount: 0,
        splitsThisFrame: 0,
        mergesThisFrame: 0,
        classifyMs: 0,
        rebuildMs: 0,
        lastVertexCount: 0,
    };

    private readonly renderParent: TransformNode;
    private readonly maxSplitsPerFrame: number;
    private readonly maxMergesPerFrame: number;
    private readonly splitThresholdPx2: number;
    private readonly splitHysteresis: number;
    private readonly cullBackface: boolean;
    private readonly cullMinDot: number;
    private readonly incrementalMesh: boolean;
    private readonly frustumGuardScale: number;
    private readonly emitCache = new CbtEmitCache();

    constructor(
        private scene: Scene,
        private camera: OriginCamera,
        opts: CbtPlanetOptions
    ) {
        this.key = opts.key;
        this.entity = opts.entity;
        this.radiusSim = opts.radiusSim;
        this.renderParent = opts.renderParent;
        this.starPosWorldDouble = opts.starPosWorldDouble;
        this.maxSplitsPerFrame = opts.maxSplitsPerFrame;
        this.maxMergesPerFrame = opts.maxMergesPerFrame ?? opts.maxSplitsPerFrame;
        this.splitThresholdPx2 = opts.splitThresholdPx2;
        this.splitHysteresis = opts.splitHysteresis;
        this.cullBackface = opts.cullBackface ?? true;
        this.cullMinDot = opts.cullMinDot ?? -0.05;
        this.incrementalMesh = opts.incrementalMesh ?? true;
        this.frustumGuardScale = opts.frustumGuardScale ?? 1.0;
        this.state = new CbtState(opts.radiusSim, opts.maxDepth);

        this.rebuildMesh();
    }

    estimatePriority(camera: OriginCamera): number {
        return Vector3.Distance(camera.doublepos, this.entity.doublepos);
    }

    resetNow(): void {
        this.pendingFullRefresh = true;
    }

    getStats(): Readonly<CbtStats> {
        return this.stats;
    }

    update(deadline: number, frustumPlanes: ReadonlyArray<Plane> | null = null): void {
        if (performance.now() >= deadline) return;

        const classifyStart = performance.now();
        const leaves = this.state.getLeafNodes();
        const { splitCandidates, mergeParents } = classifyLeaves({
            leaves,
            cameraWorldDouble: this.camera.doublepos,
            planetCenterWorldDouble: this.entity.doublepos,
            renderParentWorldMatrix: this.renderParent.getWorldMatrix(),
            viewportHeightPx: Math.max(1, this.scene.getEngine().getRenderHeight()),
            cameraFovRadians: this.camera.fov,
            splitThresholdPx2: this.splitThresholdPx2,
            splitHysteresis: this.splitHysteresis,
            cullBackface: this.cullBackface,
            cullMinDot: this.cullMinDot,
            frustumPlanes,
            frustumGuardScale: this.frustumGuardScale,
        });

        const splitCount = this.state.splitByPriority(
            splitCandidates.map((candidate) => candidate.nodeId),
            this.maxSplitsPerFrame
        );

        const mergeCount = this.state.mergeByParentPriority(
            mergeParents,
            this.maxMergesPerFrame
        );

        this.stats.classifyMs = performance.now() - classifyStart;
        this.stats.splitsThisFrame = splitCount;
        this.stats.mergesThisFrame = mergeCount;
        this.stats.leafCount = this.state.leafCount;

        if (splitCount > 0 || mergeCount > 0 || this.pendingFullRefresh) {
            const rebuildStart = performance.now();
            this.rebuildMesh();
            this.stats.rebuildMs = performance.now() - rebuildStart;
            this.pendingFullRefresh = false;
        } else {
            this.stats.rebuildMs = 0;
        }

        this.updateSunDirection();
        this.ensureShadowCaster();
    }

    dispose(): void {
        this.sunLight?.dispose();
        this.sunLight = null;
        this.material?.dispose();
        this.material = null;
        this.mesh?.dispose();
        this.mesh = null;
        this.shadowAttached = false;
    }

    private rebuildMesh(): void {
        const leaves = this.state.getLeafNodes();
        const meshData = this.incrementalMesh
            ? this.emitCache.emit(leaves, this.radiusSim)
            : emitMeshFromLeaves(leaves, this.radiusSim);
        this.stats.lastVertexCount = meshData.positions.length / 3;

        if (!this.mesh) {
            this.mesh = new Mesh(`cbt_${this.key}`, this.scene);
            this.mesh.parent = this.renderParent;
            this.mesh.checkCollisions = true;
            this.mesh.alwaysSelectAsActiveMesh = false;
            this.ensureMaterial();
            this.mesh.material = this.material;
        }

        const vertexData = new VertexData();
        vertexData.positions = meshData.positions;
        vertexData.normals = meshData.normals;
        vertexData.uvs = meshData.uvs;
        vertexData.indices = meshData.indices;
        vertexData.colors = meshData.colors;
        vertexData.applyToMesh(this.mesh, true);
        this.mesh.setVerticesData('morphDelta', meshData.morphDeltas, true, 3);
        this.mesh.useVertexColors = this.debugLod;
        this.shadowAttached = false;
    }

    private ensureMaterial(): void {
        if (this.material) return;

        // DirectionalLight oriented from star → planet
        this.sunLight = new DirectionalLight(
            `cbt_sun_${this.key}`,
            new Vector3(0, -1, 0), // placeholder, updated each frame
            this.scene
        );
        this.sunLight.intensity = 1.5;

        this.material = new StandardMaterial(`cbt_mat_${this.key}`, this.scene);
        this.material.backFaceCulling = true;
        this.material.diffuseColor = new Color3(0.6, 0.55, 0.4);
        this.material.specularColor = new Color3(0.05, 0.05, 0.05);
        this.material.useLogarithmicDepth = true;
    }

    setWireframe(on: boolean): void {
        if (this.material) this.material.wireframe = on;
    }

    setDebugLod(on: boolean): void {
        this.debugLod = on;
        if (!this.material) return;
        if (on) {
            this.material.disableLighting = true;
            this.material.emissiveColor = new Color3(1, 1, 1);
            this.material.diffuseColor = new Color3(0, 0, 0);
        } else {
            this.material.disableLighting = false;
            this.material.emissiveColor = new Color3(0, 0, 0);
            this.material.diffuseColor = new Color3(0.6, 0.55, 0.4);
        }
        if (this.mesh) {
            this.mesh.useVertexColors = on;
        }
    }

    private updateSunDirection(): void {
        if (!this.sunLight || !this.starPosWorldDouble) return;

        // Direction = normalize(starPos - planetCenter) → points from star toward planet
        const dir = this.starPosWorldDouble.subtract(this.entity.doublepos);
        if (dir.lengthSquared() < 1e-12) return;
        dir.normalize();
        this.sunLight.direction.copyFrom(dir);
    }

    private ensureShadowCaster(): void {
        if (!this.mesh) return;
        this.mesh.receiveShadows = false;
    }
}

export type CbtSchedulerOptions = {
    budgetMs?: number;
    /** Exclude off-screen (out-of-frustum) leaves from split candidates (default true). */
    frustumCull?: boolean;
};

export class CbtScheduler {
    private planets: CbtPlanet[] = [];
    private observer: Observer<Scene> | null = null;
    private budgetMs: number;
    private robin = 0;
    private wireframe = false;
    private debugLodMode = false;
    private readonly frustumCull: boolean;
    private readonly tmpViewProj = new Matrix();
    private readonly frustumPlanes: Plane[] = Frustum.GetPlanes(Matrix.Identity());
    private readonly onKeyDown: (e: KeyboardEvent) => void;

    constructor(
        private scene: Scene,
        private camera: OriginCamera,
        planets: CbtPlanet[],
        options: CbtSchedulerOptions = {}
    ) {
        this.planets = planets;
        this.budgetMs = options.budgetMs ?? 2;
        this.frustumCull = options.frustumCull ?? true;

        this.onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'w' || e.key === 'W') {
                this.wireframe = !this.wireframe;
                for (const planet of this.planets) {
                    planet.setWireframe(this.wireframe);
                }
            }
            if (e.key === 'x' || e.key === 'X') {
                this.debugLodMode = !this.debugLodMode;
                for (const planet of this.planets) {
                    planet.setDebugLod(this.debugLodMode);
                }
            }
        };
        window.addEventListener('keydown', this.onKeyDown);
    }

    setPlanets(planets: CbtPlanet[]): void {
        this.planets = planets;
        this.robin = 0;
    }

    /** Aggregate CBT telemetry across all planets for HUD / capture. */
    getStats(): CbtAggregateStats {
        const agg: CbtAggregateStats = {
            planetCount: this.planets.length,
            leafCount: 0,
            splitsThisFrame: 0,
            mergesThisFrame: 0,
            classifyMs: 0,
            rebuildMs: 0,
            vertexCount: 0,
        };
        for (const planet of this.planets) {
            const s = planet.getStats();
            agg.leafCount += s.leafCount;
            agg.splitsThisFrame += s.splitsThisFrame;
            agg.mergesThisFrame += s.mergesThisFrame;
            agg.classifyMs = Math.max(agg.classifyMs, s.classifyMs);
            agg.rebuildMs = Math.max(agg.rebuildMs, s.rebuildMs);
            agg.vertexCount += s.lastVertexCount;
        }
        return agg;
    }

    /** Per-planet centers/radii for deterministic headless capture paths. */
    getPlanetInfo(): CbtPlanetInfo[] {
        return this.planets.map((planet) => ({
            key: planet.key,
            center: [
                planet.entity.doublepos.x,
                planet.entity.doublepos.y,
                planet.entity.doublepos.z,
            ],
            radiusSim: planet.radiusSim,
        }));
    }

    /**
     * Synchronously refine all planets toward the current camera before the first
     * render, so spawn planets are not shown at minimum LOD (8 root triangles)
     * for the first ~1-2s while the per-frame budget ramps up. Bounded by `maxMs`
     * so it never freezes startup; whatever isn't converged finishes live.
     *
     * Requires the camera to be positioned and the engine to have a valid render
     * size; if the viewport is not ready yet it is a no-op (live ramp as before).
     */
    prewarm(maxMs = 120): void {
        if (!this.planets.length) return;
        const end = performance.now() + maxMs;
        const farDeadline = end + 1e9; // never trips the per-update deadline guard
        let progressing = true;
        let guard = 0;
        while (progressing && performance.now() < end && guard < 10000) {
            progressing = false;
            for (const planet of this.planets) {
                planet.update(farDeadline);
                const s = planet.getStats();
                if (s.splitsThisFrame > 0 || s.mergesThisFrame > 0) progressing = true;
            }
            guard++;
        }
    }

    start(): void {
        if (this.observer) return;
        this.observer = this.scene.onBeforeRenderObservable.add(this.tick);
    }

    stop(): void {
        if (!this.observer) return;
        this.scene.onBeforeRenderObservable.remove(this.observer);
        this.observer = null;
    }

    resetNow(): void {
        for (const planet of this.planets) {
            planet.resetNow();
        }
    }

    dispose(): void {
        window.removeEventListener('keydown', this.onKeyDown);
        this.stop();
        for (const planet of this.planets) {
            planet.dispose();
        }
        this.planets = [];
    }

    private tick = (): void => {
        const count = this.planets.length;
        if (!count) return;

        let planes: ReadonlyArray<Plane> | null = null;
        if (this.frustumCull) {
            // Render-space frustum planes for this frame (camera is at the render origin).
            this.camera
                .getViewMatrix()
                .multiplyToRef(this.camera.getProjectionMatrix(), this.tmpViewProj);
            Frustum.GetPlanesToRef(this.tmpViewProj, this.frustumPlanes);
            planes = this.frustumPlanes;
        }

        const deadline = performance.now() + this.budgetMs;
        for (let i = 0; i < count; i++) {
            if (performance.now() >= deadline) break;
            const planet = this.planets[(this.robin + i) % count];
            planet.update(deadline, planes);
        }
        this.robin = (this.robin + 1) % Math.max(1, count);
    };
}
