import {
    Frustum,
    Matrix,
    Observer,
    Plane,
    Scene,
    TransformNode,
    Vector3,
} from '@babylonjs/core';
import type {
    FloatingEntityInterface,
    OriginCamera,
} from '../../../core/camera/camera_manager';
import type { EmitResult } from './cbt_emit';
import {
    type CbtFrameParams,
    type CbtGeometrySource,
    type CbtSourceStats,
} from './cbt_geometry_source';
import { DEFAULT_NOISE, fbmNoise, fbmGroundHeight, type NoiseParams } from './cbt_noise';
import { OcbtSource } from './ocbt/ocbt_source';
import type { WebGPUEngine } from '@babylonjs/core';
import type { ResolvedLighting } from '../../../game_world/stellar_system/planet_lighting';

/** Geometry backend for a CBT planet. */
export type CbtType = 'gpu-ocbt';

export type CbtPlanetOptions = {
    key: string;
    entity: FloatingEntityInterface;
    renderParent: TransformNode;
    radiusSim: number;
    starPosWorldDouble: Vector3 | null;
    starColor: Vector3;
    starIntensity: number;
    /** Noise field shared by GPU shader and CPU collision. Default DEFAULT_NOISE. */
    noise?: NoiseParams;
    /** Per-planet resolved lighting params (from planet_lighting.json). */
    lighting?: ResolvedLighting;
};

/** Per-planet telemetry, refreshed on each {@link CbtPlanet.update}. */
export type CbtStats = {
    leafCount: number;
    splitsThisFrame: number;
    mergesThisFrame: number;
    classifyMs: number;
    rebuildMs: number;
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
    /** OCBT compute GPU time (ms, last-second average), summed across planets — topology bucket. */
    ocbtTopoMs: number;
    /** OCBT EvaluateLEB (df64 noise) GPU time (ms), summed across planets. */
    ocbtEvalMs: number;
    /** OCBT draw-compaction GPU time (ms), summed across planets. */
    ocbtCompactMs: number;
};

export class CbtPlanet {
    readonly key: string;
    readonly entity: FloatingEntityInterface;
    readonly radiusSim: number;
    readonly starPosWorldDouble: Vector3 | null;

    // Lazily created on first update() that passes the SSE threshold, so we don't
    // flood the WebGPU driver with 224 compute pipelines at startup (one per planet
    // × 14 shaders). Creation is deferred until the camera is actually close enough
    // to need terrain detail for this planet.
    private source: CbtGeometrySource | null = null;
    private readonly sourceOpts: CbtPlanetOptions;

    private debugLod = false;
    private pendingWireframe = false;
    private pendingDebugLod = false;
    private _visible = true;
    private readonly stats: CbtStats = {
        leafCount: 0,
        splitsThisFrame: 0,
        mergesThisFrame: 0,
        classifyMs: 0,
        rebuildMs: 0,
    };

    private readonly renderParent: TransformNode;
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
        this.starColor = opts.starColor;
        this.noise = opts.noise ?? DEFAULT_NOISE;
        this.sourceOpts = opts;
        // Source is NOT created here — deferred to the first update() call.
    }

    private getOrCreateSource(): CbtGeometrySource {
        if (!this.source) {
            this.source = this.createSource(this.sourceOpts);
            this.source.refresh();
            // Apply any debug flags that were toggled before this planet activated.
            this.source.setWireframe?.(this.pendingWireframe);
            this.source.setDebugLod?.(this.pendingDebugLod);
            this.source.setVisible?.(this._visible);
        }
        return this.source;
    }

    private createSource(opts: CbtPlanetOptions): CbtGeometrySource {
        const engine = this.scene.getEngine();
        // OCBT (pool-CBT, HPG 2024): cost decoupled from subdivision depth via fixed
        // pool capacity. Owns its own mesh/material; the listener is telemetry-only.
        // Right-sized to the measured ground peak (~401k live leaves at the grazing pole on Dev/Moon,
        // split 16px): 1<<19 = 524 288 slots holds it with ~24% headroom while halving the O(capacity)
        // topology passes (copy_neighbors / reduce / classify) and freeing ~190 MB VRAM per planet vs
        // 1<<20. Do NOT drop to 1<<18 (262k < the 401k peak → the limb under-tessellates). The readback
        // saturation guard in OcbtSource warns once if any planet's live count approaches this pool.
        const OCBT_CAPACITY = 1 << 19; // 524 288 slots
        const OCBT_MAX_LEVEL = 32; // u64 hard cap; df64 cracks well before
        // Subdivision FLOOR: the whole sphere is force-refined to at least this level so it never
        // shows the bare 8 octahedron faces (faceted limb) when far or merging. Cost is fixed and
        // tiny: a full sphere at level L is 8*2^L triangles (level 6 = 512). Raise for a rounder
        // far-away limb, lower to save draw instances on distant bodies.
        const OCBT_MIN_LEVEL = 6;
        // Hysteresis: MERGE < SPLIT/sqrt(2). 8/4 keeps a safe gap (4 < 5.66).
        const OCBT_SPLIT_PX = 16;
        const OCBT_MERGE_PX = 8;
        return new OcbtSource(
            engine as WebGPUEngine,
            this.scene,
            {
                key: opts.key,
                renderParent: this.renderParent,
                radiusSim: opts.radiusSim,
                noise: this.noise,
                starColor: this.starColor,
                starIntensity: opts.starIntensity,
                starPosWorldDouble: this.starPosWorldDouble,
                capacity: OCBT_CAPACITY,
                splitThresholdPx: OCBT_SPLIT_PX,
                mergeThresholdPx: OCBT_MERGE_PX,
                maxLevel: OCBT_MAX_LEVEL,
                minLevel: OCBT_MIN_LEVEL,
                lighting: opts.lighting
            },
            this.onSourceUpdate
        );
    }

    private onSourceUpdate = (
        _geometry: EmitResult | null,
        stats: CbtSourceStats
    ): void => {
        this.stats.classifyMs = stats.classifyMs;
        this.stats.splitsThisFrame = stats.splitsThisFrame;
        this.stats.mergesThisFrame = stats.mergesThisFrame;
        this.stats.leafCount = stats.leafCount;
        this.stats.rebuildMs = 0;
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
     * Exact at any LOD depth — no GPU readback.
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
        this.source?.reset();
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

    /** OCBT compute GPU timings (ms) for the perf HUD; zeros until the source is created. */
    getGpuTimings(): { topoMs: number; evalMs: number; compactMs: number } {
        return this.source?.getGpuTimings?.() ?? { topoMs: 0, evalMs: 0, compactMs: 0 };
    }

    /** Whether the planet mesh is currently drawn (set by the scheduler frustum cull). */
    get visible(): boolean {
        return this._visible;
    }

    /** Bounding-sphere radius (sea level + max relief) for the render-space frustum test. */
    get boundingRadiusSim(): number {
        return this.radiusSim + this.noise.globalAmplitude;
    }

    /**
     * Show/hide the planet mesh. Called by the scheduler when the planet leaves/enters the
     * camera frustum: an off-screen OCBT mesh has procedural bounds (alwaysSelectAsActiveMesh)
     * so Babylon never culls it — without this it keeps drawing its full leaf set every frame.
     * No-op if unchanged; forwarded to the source (which disables the Babylon mesh) once created.
     */
    setVisible(on: boolean): void {
        if (on === this._visible) return;
        this._visible = on;
        this.source?.setVisible?.(on);
    }

    update(deadline: number, frustumPlanes: ReadonlyArray<Plane> | null = null): void {
        if (performance.now() >= deadline) return;
        this.getOrCreateSource().requestUpdate({
            cameraWorldDouble: this.camera.doublepos,
            planetCenterWorldDouble: this.entity.doublepos,
            renderParentWorldMatrix: this.renderParent.getWorldMatrix(),
            viewportHeightPx: Math.max(1, this.scene.getEngine().getRenderHeight()),
            cameraFovRadians: this.camera.fov,
            frustumPlanes,
        });
    }

    dispose(): void {
        this.source?.dispose();
    }

    setWireframe(on: boolean): void {
        this.pendingWireframe = on;
        this.source?.setWireframe?.(on);
    }

    setDebugLod(on: boolean): void {
        this.debugLod = on;
        this.pendingDebugLod = on;
        this.source?.setDebugLod?.(on);
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
    /** Render-space frustum planes stashed by runVisibility() for runCompute() (same frame). */
    private framePlanes: ReadonlyArray<Plane> | null = null;
    /**
     * While false, the onBeforeRender observer drives the heavy compute loop — the startup transient
     * before the Frame Graph is built. Once the graph's OCBT compute task takes ownership it is flipped
     * true, so the heavy loop runs ONLY from the graph task (no double-tick). See setGraphOwnsCompute.
     */
    private graphOwnsCompute = false;
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
            ocbtTopoMs: 0,
            ocbtEvalMs: 0,
            ocbtCompactMs: 0,
        };
        for (const planet of this.planets) {
            const s = planet.getStats();
            agg.leafCount += s.leafCount;
            agg.splitsThisFrame += s.splitsThisFrame;
            agg.mergesThisFrame += s.mergesThisFrame;
            agg.classifyMs = Math.max(agg.classifyMs, s.classifyMs);
            agg.rebuildMs = Math.max(agg.rebuildMs, s.rebuildMs);
            agg.vertexCount += s.leafCount * 3;
            const t = planet.getGpuTimings();
            agg.ocbtTopoMs += t.topoMs;
            agg.ocbtEvalMs += t.evalMs;
            agg.ocbtCompactMs += t.compactMs;
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

        // Only warm planets that are LOD-active from the current camera position.
        // Warming all 16 planets wastes the prewarm budget on inter-system bodies.
        const viewH = this.scene.getEngine().getRenderHeight();
        const K = viewH > 0
            ? viewH / (2 * Math.tan(this.camera.fov * 0.5))
            : 780; // fallback: ~1080p / 70° fov
        const SKIP_SSE_PX = 4.0;
        const cam = this.camera.doublepos;

        let progressing = true;
        let guard = 0;
        while (progressing && performance.now() < end && guard < 10000) {
            progressing = false;
            for (const planet of this.planets) {
                const c = planet.entity.doublepos;
                const dx = cam.x - c.x, dy = cam.y - c.y, dz = cam.z - c.z;
                const dist = Math.max(Math.sqrt(dx*dx + dy*dy + dz*dz), 1);
                if ((planet.radiusSim * 0.5) * K / dist < SKIP_SSE_PX) continue;

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

    // Scratch vectors for distance/visibility checks — avoid per-frame allocation in tick().
    private readonly tmpCamOffset = new Vector3();
    private readonly tmpCenterRender = new Vector3();

    /**
     * Render-space bounding-sphere vs frustum test. Babylon never frustum-culls the OCBT mesh
     * (alwaysSelectAsActiveMesh — procedural bounds), so an off-screen planet would otherwise
     * keep drawing its full leaf set AND keep refining every frame. We do the cull here.
     *
     * Inward-normal convention (Babylon Frustum.GetPlanes): a point is inside when
     * plane.dotCoordinate(p) >= 0; a sphere is fully outside a plane when dotCoordinate <= -r.
     * Conservative: cull only when fully outside ONE plane. The body the camera is on/inside is
     * always kept (its sphere surrounds the origin), so the ground planet never flickers off.
     */
    private isPlanetVisible(
        planet: CbtPlanet,
        planes: ReadonlyArray<Plane> | null
    ): boolean {
        if (!planes) return true;
        const r = planet.boundingRadiusSim;
        const c = this.camera.toRenderSpace(planet.entity.doublepos, this.tmpCenterRender);
        // Camera inside / very near the planet (the body you are standing on): always visible.
        const near = r * 1.5;
        if (c.lengthSquared() < near * near) return true;
        for (let i = 0; i < 6; i++) {
            if (planes[i].dotCoordinate(c) <= -r) return false;
        }
        return true;
    }

    /**
     * onBeforeRender observer. Always runs the cheap visibility cull (must precede Babylon's
     * active-mesh evaluation so the FrameGraphObjectList sees this frame's enabled set). The heavy
     * compute loop runs here ONLY during the startup transient before the Frame Graph takes over —
     * once {@link setGraphOwnsCompute} is flipped, the graph's OCBT compute task drives runCompute().
     */
    private tick = (): void => {
        this.runVisibility();
        if (!this.graphOwnsCompute) this.runCompute();
    };

    /**
     * Cheap per-frame pass: compute this frame's render-space frustum planes and cull off-screen
     * planet meshes (an off-screen OCBT mesh has procedural bounds → Babylon never frustum-culls it).
     * An invisible planet is also frozen in runCompute(). Stashes the planes for runCompute() to reuse;
     * under floating origin those render-space planes are orientation-only, so they remain valid after
     * the camera fold that runs between this pass and the compute task.
     */
    runVisibility(): void {
        const count = this.planets.length;
        if (!count) {
            this.framePlanes = null;
            return;
        }
        let planes: ReadonlyArray<Plane> | null = null;
        if (this.frustumCull) {
            // Render-space frustum planes for this frame (camera is at the render origin).
            this.camera
                .getViewMatrix()
                .multiplyToRef(this.camera.getProjectionMatrix(), this.tmpViewProj);
            Frustum.GetPlanesToRef(this.tmpViewProj, this.frustumPlanes);
            planes = this.frustumPlanes;
        }
        this.framePlanes = planes;
        for (let i = 0; i < count; i++) {
            this.planets[i].setVisible(this.isPlanetVisible(this.planets[i], planes));
        }
    }

    /**
     * Heavy per-frame pass: the budgeted, round-robin OCBT topology/eval/compact compute. Driven by
     * the Frame Graph compute task (or, before the graph is ready, by tick()). Reads the planes stashed
     * by runVisibility().
     */
    runCompute(): void {
        const count = this.planets.length;
        if (!count) return;
        const planes = this.framePlanes;

        // Per-frame SSE constant: converts world-space error to pixels.
        // Same formula as the GPU classifier: ssePx = error * K / dist,
        // where K = viewportHeight / (2 * tan(fov/2)).
        const viewH = this.scene.getEngine().getRenderHeight();
        const K = viewH / (2 * Math.tan(this.camera.fov * 0.5));

        // Skip threshold: if the root node SSE is below this, the planet will never
        // split — no GPU compute needed. 4 px = half the OCBT merge threshold (8 px),
        // giving a 2× safety margin so inter-system planets are always culled while
        // a planet the camera is approaching stays active well before it would split.
        const SKIP_SSE_PX = 4.0;

        const cam = this.camera.doublepos;
        const deadline = performance.now() + this.budgetMs;
        for (let i = 0; i < count; i++) {
            if (performance.now() >= deadline) break;
            const planet = this.planets[(this.robin + i) % count];

            // Off-screen → frozen: no topology/EvaluateLEB compute while the mesh is culled.
            if (!planet.visible) continue;

            // Root-node SSE: error ≈ radius/2, distance = camera → planet center.
            const c = planet.entity.doublepos;
            this.tmpCamOffset.set(cam.x - c.x, cam.y - c.y, cam.z - c.z);
            const dist = Math.max(this.tmpCamOffset.length(), 1);
            const rootSsePx = (planet.radiusSim * 0.5) * K / dist;
            if (rootSsePx < SKIP_SSE_PX) continue;

            planet.update(deadline, planes);
        }
        this.robin = (this.robin + 1) % Math.max(1, count);
    }

    /**
     * Hand ownership of the heavy compute loop to the Frame Graph's OCBT compute task. Called once the
     * graph has been built (see attachFrameGraph's onGraphReady). Until then tick() runs runCompute()
     * itself so the startup transient (before scene.frameGraph is installed) is not frozen.
     */
    setGraphOwnsCompute(owned: boolean): void {
        this.graphOwnsCompute = owned;
    }
}
