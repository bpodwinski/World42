import {
    Color3,
    DirectionalLight,
    Frustum,
    Matrix,
    Mesh,
    Observer,
    Plane,
    Scene,
    ShaderMaterial,
    StandardMaterial,
    TransformNode,
    Vector3,
    VertexData,
} from '@babylonjs/core';
import type {
    FloatingEntityInterface,
    OriginCamera,
} from '../../../core/camera/camera_manager';
import type { EmitResult } from './cbt_emit';
import {
    LocalCbtSource,
    type CbtFrameParams,
    type CbtGeometrySource,
    type CbtSourceStats,
    type LocalCbtSourceOptions,
} from './cbt_geometry_source';
import { DEFAULT_NOISE, type NoiseParams } from './cbt_noise';
import { createCbtTerrainMaterial } from './cbt_terrain_shader';
import { getGlobalCbtKernelClient } from './workers/cbt_kernel_client';
import { WorkerCbtSource } from './workers/cbt_worker_source';
import { GpuCbtSource } from './gpu/gpu_cbt_source';
import type { WebGPUEngine } from '@babylonjs/core';

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
    /**
     * Use the per-pixel-normal ShaderMaterial (default true). When false, falls
     * back to the legacy StandardMaterial (Gouraud, vertex normals).
     */
    perPixelNormals?: boolean;
    /**
     * Noise field for CPU displacement AND the per-pixel-normal shader (they must
     * match). Default DEFAULT_NOISE. See cbt_quality.ts for presets.
     */
    noise?: NoiseParams;
    /**
     * Run classify/split/merge/emit in a Rust/WASM worker instead of on the main
     * thread (default false). The synchronous path stays the fallback + golden
     * reference. The worker path is wired in Phase 3.
     */
    offThreadCbt?: boolean;
    /**
     * Run the full CBT on the GPU (Dupuy 2021: bitfield + sum-reduction +
     * split/merge compute passes + implicit-mesh draw), WebGPU only. Default
     * false. Takes precedence over {@link offThreadCbt} when both are set and the
     * engine is WebGPU; otherwise the worker/sync path is used. Wired in Phase 5.
     */
    gpuCbt?: boolean;
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
    private material: StandardMaterial | ShaderMaterial | null = null;
    private sunLight: DirectionalLight | null = null;
    private source: CbtGeometrySource;
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
    private readonly perPixelNormals: boolean;
    private readonly starColor: Vector3;
    private readonly noise: NoiseParams;

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
        this.perPixelNormals = opts.perPixelNormals ?? true;
        this.starColor = opts.starColor;
        this.noise = opts.noise ?? DEFAULT_NOISE;
        this.source = this.createSource(opts);

        // Initial mesh: emit the 8 root triangles (no classify) so the planet
        // exists before the first refinement pass.
        this.source.refresh();
    }

    private createSource(opts: CbtPlanetOptions): CbtGeometrySource {
        // GPU CBT path (WebGPU only): a fully GPU-resident concurrent binary tree
        // rendered as an implicit mesh. Owns its own mesh/material; the listener is
        // called for telemetry only. Supersedes the worker/sync path when enabled.
        const engine = this.scene.getEngine();
        if (opts.gpuCbt && (engine as WebGPUEngine).isWebGPU) {
            // The simple GPU path dispatches/draws 2^maxDepth instances every frame,
            // so each extra depth level DOUBLES the draw/dispatch cost (the quality
            // preset's depth ~28 would be 2^28 instances). 22 → 2^22 ≈ 4M instances,
            // most early-out as degenerate. Deeper trees via a render leaf-cap are
            // Phase 3b/5.
            const GPU_MAX_DEPTH = 22;
            // GPU-specific split threshold (px²): lower than the worker preset so the
            // implicit mesh subdivides finer everywhere. Cost scales ~linearly with the
            // resulting live leaf count (not exponential like GPU_MAX_DEPTH).
            const GPU_SPLIT_THRESHOLD_PX2 = 40;
            return new GpuCbtSource(
                engine as WebGPUEngine,
                this.scene,
                {
                    key: opts.key,
                    renderParent: this.renderParent,
                    radiusSim: opts.radiusSim,
                    noise: this.noise,
                    starColor: this.starColor,
                    starPosWorldDouble: this.starPosWorldDouble,
                    maxDepth: Math.min(opts.maxDepth, GPU_MAX_DEPTH),
                    splitThresholdPx2: Math.min(opts.splitThresholdPx2, GPU_SPLIT_THRESHOLD_PX2),
                    splitHysteresis: opts.splitHysteresis,
                    cullBackface: opts.cullBackface ?? true,
                    cullMinDot: opts.cullMinDot ?? -0.05,
                },
                this.onSourceUpdate
            );
        }

        const sourceOpts: LocalCbtSourceOptions = {
            radiusSim: opts.radiusSim,
            maxDepth: opts.maxDepth,
            maxSplitsPerFrame: opts.maxSplitsPerFrame,
            maxMergesPerFrame: opts.maxMergesPerFrame ?? opts.maxSplitsPerFrame,
            splitThresholdPx2: opts.splitThresholdPx2,
            splitHysteresis: opts.splitHysteresis,
            cullBackface: opts.cullBackface ?? true,
            cullMinDot: opts.cullMinDot ?? -0.05,
            frustumGuardScale: opts.frustumGuardScale ?? 1.0,
            incrementalMesh: opts.incrementalMesh ?? true,
            noise: this.noise,
        };
        // Off-thread path: run the identical pipeline in the Rust/WASM worker. The
        // worker owns the tree; only camera params go out and geometry comes back.
        if (opts.offThreadCbt) {
            // Spawn frame the worker refines toward before the first geometry, so
            // the planet is not shown at minimum LOD (no-frustum, like the sync
            // prewarm). renderParent matrix is computed on demand here.
            const prewarmFrame: CbtFrameParams = {
                cameraWorldDouble: this.camera.doublepos,
                planetCenterWorldDouble: this.entity.doublepos,
                renderParentWorldMatrix: this.renderParent.getWorldMatrix(),
                viewportHeightPx: Math.max(1, this.scene.getEngine().getRenderHeight()),
                cameraFovRadians: this.camera.fov,
                frustumPlanes: null,
            };
            return new WorkerCbtSource(
                getGlobalCbtKernelClient(),
                {
                    key: opts.key,
                    radiusSim: sourceOpts.radiusSim,
                    maxDepth: sourceOpts.maxDepth,
                    maxSplitsPerFrame: sourceOpts.maxSplitsPerFrame,
                    maxMergesPerFrame: sourceOpts.maxMergesPerFrame,
                    splitThresholdPx2: sourceOpts.splitThresholdPx2,
                    splitHysteresis: sourceOpts.splitHysteresis,
                    cullBackface: sourceOpts.cullBackface,
                    cullMinDot: sourceOpts.cullMinDot,
                    frustumGuardScale: sourceOpts.frustumGuardScale,
                    incrementalMesh: sourceOpts.incrementalMesh,
                    noise: sourceOpts.noise,
                    prewarmFrame,
                },
                this.onSourceUpdate
            );
        }
        return new LocalCbtSource(sourceOpts, this.onSourceUpdate);
    }

    private onSourceUpdate = (
        geometry: EmitResult | null,
        stats: CbtSourceStats
    ): void => {
        this.stats.classifyMs = stats.classifyMs;
        this.stats.splitsThisFrame = stats.splitsThisFrame;
        this.stats.mergesThisFrame = stats.mergesThisFrame;
        this.stats.leafCount = stats.leafCount;

        if (geometry) {
            const applyStart = performance.now();
            this.applyGeometry(geometry);
            // rebuildMs preserves the prior meaning: emit + GPU upload.
            this.stats.rebuildMs = stats.emitMs + (performance.now() - applyStart);
        } else {
            this.stats.rebuildMs = 0;
        }
    };

    estimatePriority(camera: OriginCamera): number {
        return Vector3.Distance(camera.doublepos, this.entity.doublepos);
    }

    resetNow(): void {
        this.source.reset();
    }

    getStats(): Readonly<CbtStats> {
        return this.stats;
    }

    update(deadline: number, frustumPlanes: ReadonlyArray<Plane> | null = null): void {
        if (performance.now() >= deadline) return;

        // Dispatch one classify/split/merge/emit cycle to the geometry source.
        // For the local source this runs synchronously and invokes
        // onSourceUpdate before returning; the worker source (Phase 3) replies
        // asynchronously.
        this.source.requestUpdate({
            cameraWorldDouble: this.camera.doublepos,
            planetCenterWorldDouble: this.entity.doublepos,
            renderParentWorldMatrix: this.renderParent.getWorldMatrix(),
            viewportHeightPx: Math.max(1, this.scene.getEngine().getRenderHeight()),
            cameraFovRadians: this.camera.fov,
            frustumPlanes,
        });

        this.updateSunDirection();
        this.ensureShadowCaster();
    }

    dispose(): void {
        this.source.dispose();
        this.sunLight?.dispose();
        this.sunLight = null;
        this.material?.dispose();
        this.material = null;
        this.mesh?.dispose();
        this.mesh = null;
        this.shadowAttached = false;
    }

    private applyGeometry(meshData: EmitResult): void {
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

        if (this.perPixelNormals) {
            // Per-pixel-normal shader: shading is decoupled from tessellation,
            // so it does not pop when triangles refine. No DirectionalLight
            // needed — lighting is driven by the uLightDirection uniform.
            this.material = createCbtTerrainMaterial(this.scene, this.key, {
                radius: this.radiusSim,
                noise: this.noise,
                lightColor: this.starColor
            });
            return;
        }

        // Legacy fallback: StandardMaterial (Gouraud, vertex normals).
        // DirectionalLight oriented from star → planet
        this.sunLight = new DirectionalLight(
            `cbt_sun_${this.key}`,
            new Vector3(0, -1, 0), // placeholder, updated each frame
            this.scene
        );
        this.sunLight.intensity = 1.5;

        const std = new StandardMaterial(`cbt_mat_${this.key}`, this.scene);
        std.backFaceCulling = true;
        std.diffuseColor = new Color3(0.6, 0.55, 0.4);
        std.specularColor = new Color3(0.05, 0.05, 0.05);
        std.useLogarithmicDepth = true;
        this.material = std;
    }

    setWireframe(on: boolean): void {
        if (this.material) this.material.wireframe = on;
        this.source.setWireframe?.(on);
    }

    setDebugLod(on: boolean): void {
        this.debugLod = on;
        // GPU path: the material is owned by the source, not CbtPlanet.
        this.source.setDebugLod?.(on);
        if (!this.material) return;
        if (this.material instanceof ShaderMaterial) {
            this.material.setInt('uDebugLod', on ? 1 : 0);
        } else {
            if (on) {
                this.material.disableLighting = true;
                this.material.emissiveColor = new Color3(1, 1, 1);
                this.material.diffuseColor = new Color3(0, 0, 0);
            } else {
                this.material.disableLighting = false;
                this.material.emissiveColor = new Color3(0, 0, 0);
                this.material.diffuseColor = new Color3(0.6, 0.55, 0.4);
            }
        }
        if (this.mesh) {
            this.mesh.useVertexColors = on;
        }
    }

    private updateSunDirection(): void {
        if (!this.starPosWorldDouble) return;

        // Direction = normalize(starPos - planetCenter) → points from star toward planet
        const dir = this.starPosWorldDouble.subtract(this.entity.doublepos);
        if (dir.lengthSquared() < 1e-12) return;
        dir.normalize();

        if (this.material instanceof ShaderMaterial) {
            this.material.setVector3('uLightDirection', dir);
        } else if (this.sunLight) {
            this.sunLight.direction.copyFrom(dir);
        }
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
