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
import { DEFAULT_NOISE, fbmNoise, fbmGroundHeight, type NoiseParams } from './cbt_noise';
import { createCbtTerrainMaterial } from './cbt_terrain_shader';
import { getGlobalCbtKernelClient } from './workers/cbt_kernel_client';
import { WorkerCbtSource } from './workers/cbt_worker_source';
import { GpuCbtSource } from './gpu/gpu_cbt_source';
import { OcbtSource } from './ocbt/ocbt_source';
import type { WebGPUEngine } from '@babylonjs/core';

/** Geometry backend for a CBT planet. */
export type CbtType = 'cpu' | 'gpu-implicit' | 'gpu-ocbt';

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
    /**
     * Geometry backend selector (supersedes {@link gpuCbt}). 'cpu' = worker/sync,
     * 'gpu-implicit' = the Dupuy 2021 implicit CBT, 'gpu-ocbt' = the pool-CBT
     * concurrent engine (HPG 2024). When unset, falls back to gpuCbt ?
     * 'gpu-implicit' : 'cpu'. WebGPU required for both GPU paths.
     */
    cbtType?: CbtType;
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
        const engine = this.scene.getEngine();
        const cbtType: CbtType = opts.cbtType ?? (opts.gpuCbt ? 'gpu-implicit' : 'cpu');

        // OCBT path (WebGPU only): the pool-CBT concurrent engine (HPG 2024). Cost is
        // decoupled from subdivision depth (fixed pool capacity). Owns its own
        // mesh/material; the listener is telemetry-only.
        if (cbtType === 'gpu-ocbt' && (engine as WebGPUEngine).isWebGPU) {
            // Phase 2 bring-up constants: a fixed pool plus a screen-space-area metric.
            // f32 vertex decode caps usable depth (~16); Phase 3 lifts it via f64.
            const OCBT_CAPACITY = 1 << 20; // 1 048 576 slots
            const OCBT_MAX_LEVEL = 32; // u64 hard cap (depth 63); df64 cracks well before
            // Hysteresis rule: MERGE must be < SPLIT / sqrt(2) (~0.707*SPLIT). A longest-edge
            // split makes children edge = parent/sqrt(2); if MERGE >= that, the children merge
            // back the next frame -> split/merge oscillate every frame (leafCount flips,
            // debug-LOD flickers). 8/4 keeps a safe gap (4 < 5.66).
            const OCBT_SPLIT_PX = 8; // split when longest edge > 8 px
            const OCBT_MERGE_PX = 4; // merge < 8/sqrt(2)=5.66 px (stable hysteresis)
            return new OcbtSource(
                engine as WebGPUEngine,
                this.scene,
                {
                    key: opts.key,
                    renderParent: this.renderParent,
                    radiusSim: opts.radiusSim,
                    noise: this.noise,
                    starColor: this.starColor,
                    starPosWorldDouble: this.starPosWorldDouble,
                    capacity: OCBT_CAPACITY,
                    splitThresholdPx: OCBT_SPLIT_PX,
                    mergeThresholdPx: OCBT_MERGE_PX,
                    maxLevel: OCBT_MAX_LEVEL
                },
                this.onSourceUpdate
            );
        }

        // GPU CBT path (WebGPU only): a fully GPU-resident concurrent binary tree
        // rendered as an implicit mesh. Owns its own mesh/material; the listener is
        // called for telemetry only. Supersedes the worker/sync path when enabled.
        if (cbtType === 'gpu-implicit' && (engine as WebGPUEngine).isWebGPU) {
            // The update is now dispatched INDIRECTLY (workgroups = ceil(liveLeaves/256))
            // and the draw is bounded via forcedInstanceCount, so per-frame cost scales
            // with the LIVE leaf count, not 2^maxDepth. The residual O(2^maxDepth) term
            // is the sum-reduction (breadth-first over the full tree), which becomes the
            // ceiling — hence ~24-25 is the practical max, not the worker's 28. Heap mem
            // ≈ 8.4 MB/planet at 24 (16.8 MB at 25). 25 is opt-in after a perf check.
            const GPU_MAX_DEPTH = 25;
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

    private readonly tmpCollOffset = new Vector3();
    private readonly tmpCollDir = new Vector3();
    private readonly tmpCollInv = new Matrix();

    /**
     * Analytic hard-floor ground collision. The CBT/OCBT surface has no CPU mesh
     * (it lives only in GPU buffers / is procedurally bounded), so Babylon mesh
     * collision can't see it. Instead we clamp the camera against the SAME fbm
     * height field the shader renders:
     *
     *   groundRadius(dir) = radiusSim + fbmNoise(dir)   (planet-LOCAL rotating frame)
     *
     * When the camera is below ground + clearance, it is pushed radially out to
     * the floor. Returns true if it moved. Cheap early-rejects for far planets.
     * Exact at any LOD depth — no GPU readback. (CDLOD planets use a different,
     * worker-side height field and are not handled here.)
     */
    resolveGroundCollision(clearanceSim: number): boolean {
        const center = this.entity.doublepos;
        // The OriginCamera integrates `doublepos += position` LATER this frame (on
        // onBeforeActiveMeshesEvaluation), AFTER this onBeforeRender callback. So the
        // steering move still sits in camera.position (render-space) and is NOT yet in
        // doublepos. Test the EFFECTIVE post-integration position (doublepos + position) or
        // we clamp a stale point and the camera tunnels THROUGH the surface for one frame at
        // high speed, then pops back. render-space origin == camera doublepos, so adding the
        // render-space offset to doublepos yields the upcoming absolute position.
        const camPos = this.camera.position;
        this.tmpCollOffset.set(
            this.camera.doublepos.x + camPos.x - center.x,
            this.camera.doublepos.y + camPos.y - center.y,
            this.camera.doublepos.z + camPos.z - center.z
        );
        const dist = this.tmpCollOffset.length();
        if (dist < 1e-6) return false;
        // Above the highest possible ground + clearance: nothing to do.
        const maxGround = this.radiusSim + this.noise.globalAmplitude + clearanceSim;
        if (dist >= maxGround) return false;
        // Local (rotating-frame) direction = inverse(renderParent rotation) * worldOffset.
        // TransformNormal uses the matrix' 3x3 only, so the per-frame render-space
        // translation is irrelevant; the rotation matches the shader's mat3(world).
        this.renderParent.getWorldMatrix().invertToRef(this.tmpCollInv);
        Vector3.TransformNormalToRef(this.tmpCollOffset, this.tmpCollInv, this.tmpCollDir);
        this.tmpCollDir.normalize();
        // Match the VISIBLE OCBT surface (macro + distance-faded detail), not the macro-only
        // field — else the camera floats over detail troughs. camDist = camera->ground point
        // (radially, dist - radius) so the per-octave fade matches the shader's vertex fade.
        const camDistKm = Math.max(dist - this.radiusSim, 0);
        const groundR =
            this.radiusSim +
            fbmGroundHeight(
                this.tmpCollDir.x, this.tmpCollDir.y, this.tmpCollDir.z,
                this.noise, camDistKm, this.radiusSim
            );
        const minDist = groundR + clearanceSim;
        if (dist >= minDist) return false;
        // Push radially out to the floor, and CONSUME the pending render move: write the
        // clamped absolute into doublepos and zero camera.position so the later integration
        // (doublepos += position) lands exactly here THIS frame — no tunnel, no one-frame
        // dip. Zeroing also kills the inward velocity (doublepos stops advancing into the
        // ground), so the camera doesn't keep ramming / jittering at the floor.
        const scale = minDist / dist;
        this.camera.doublepos.set(
            center.x + this.tmpCollOffset.x * scale,
            center.y + this.tmpCollOffset.y * scale,
            center.z + this.tmpCollOffset.z * scale
        );
        camPos.set(0, 0, 0);
        return true;
    }

    resetNow(): void {
        this.source.reset();
    }

    /**
     * Camera distance to this planet's center, and the TERRAIN ground radius directly under
     * the camera — the SAME analytic fbm field the shader renders and the collision clamps to
     * (planet-local rotating frame). Altitude-above-terrain = distSim - groundRSim; the
     * sea-level approximation would instead use radiusSim.
     */
    cameraGroundInfo(): { distSim: number; groundRSim: number } {
        const center = this.entity.doublepos;
        this.tmpCollOffset.copyFrom(this.camera.doublepos).subtractInPlace(center);
        const dist = this.tmpCollOffset.length();
        if (dist < 1e-6) return { distSim: dist, groundRSim: this.radiusSim };
        this.renderParent.getWorldMatrix().invertToRef(this.tmpCollInv);
        Vector3.TransformNormalToRef(this.tmpCollOffset, this.tmpCollInv, this.tmpCollDir);
        this.tmpCollDir.normalize();
        // Same VISIBLE-surface height as the collision so the HUD altitude matches the floor.
        const camDistKm = Math.max(dist - this.radiusSim, 0);
        const groundR =
            this.radiusSim +
            fbmGroundHeight(
                this.tmpCollDir.x, this.tmpCollDir.y, this.tmpCollDir.z,
                this.noise, camDistKm, this.radiusSim
            );
        return { distSim: dist, groundRSim: groundR };
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

        // lightDirection convention: planetCenter - starPos (star→planet), shader negates to get L toward star.
        const dir = this.entity.doublepos.subtract(this.starPosWorldDouble);
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
            // GPU-driven sources (OCBT/GPU-CBT) emit no CPU vertices, so lastVertexCount is 0.
            // They draw 1 instanced 3-vertex template per live leaf, so the rendered vertex
            // count is leafCount * 3 (1 triangle / leaf). Fall back to that when there is no
            // CPU vertex count, so the HUD "verts" reflects the real geometry being drawn.
            agg.vertexCount += s.lastVertexCount || s.leafCount * 3;
        }
        return agg;
    }

    /**
     * Analytic hard-floor ground collision against the CBT/OCBT planets. The
     * camera can only be inside one planet's surface at a time, so we stop at the
     * first that clamps. Call once per frame AFTER the camera control has moved.
     */
    resolveGroundCollision(clearanceSim: number): void {
        for (const planet of this.planets) {
            if (planet.resolveGroundCollision(clearanceSim)) break;
        }
    }

    /**
     * Nearest CBT/OCBT planet to the camera with its terrain-aware ground info, for the HUD
     * altitude read-out (so altitude is measured above the actual terrain, not sea level).
     */
    getNearestGroundInfo(): {
        key: string;
        distSim: number;
        groundRSim: number;
        radiusSim: number;
    } | null {
        let best: CbtPlanet | null = null;
        let bestDist = Infinity;
        for (const planet of this.planets) {
            const d = Vector3.Distance(this.camera.doublepos, planet.entity.doublepos);
            if (d < bestDist) {
                bestDist = d;
                best = planet;
            }
        }
        if (!best) return null;
        const g = best.cameraGroundInfo();
        return { key: best.key, distSim: g.distSim, groundRSim: g.groundRSim, radiusSim: best.radiusSim };
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
