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
};

export class CbtPlanet {
    readonly key: string;
    readonly entity: FloatingEntityInterface;
    readonly radiusSim: number;
    readonly starPosWorldDouble: Vector3 | null;

    private source: CbtGeometrySource;
    private debugLod = false;
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
        this.source = this.createSource(opts);
        this.source.refresh();
    }

    private createSource(opts: CbtPlanetOptions): CbtGeometrySource {
        const engine = this.scene.getEngine();
        // OCBT (pool-CBT, HPG 2024): cost decoupled from subdivision depth via fixed
        // pool capacity. Owns its own mesh/material; the listener is telemetry-only.
        const OCBT_CAPACITY = 1 << 20; // 1 048 576 slots
        const OCBT_MAX_LEVEL = 32; // u64 hard cap; df64 cracks well before
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
        this.source.requestUpdate({
            cameraWorldDouble: this.camera.doublepos,
            planetCenterWorldDouble: this.entity.doublepos,
            renderParentWorldMatrix: this.renderParent.getWorldMatrix(),
            viewportHeightPx: Math.max(1, this.scene.getEngine().getRenderHeight()),
            cameraFovRadians: this.camera.fov,
            frustumPlanes,
        });
    }

    dispose(): void {
        this.source.dispose();
    }

    setWireframe(on: boolean): void {
        this.source.setWireframe?.(on);
    }

    setDebugLod(on: boolean): void {
        this.debugLod = on;
        this.source.setDebugLod?.(on);
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
            agg.vertexCount += s.leafCount * 3;
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
