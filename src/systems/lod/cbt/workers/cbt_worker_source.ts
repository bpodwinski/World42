/**
 * Worker-backed {@link CbtGeometrySource}: forwards each frame's camera to the
 * off-thread CBT kernel and delivers the emitted geometry back asynchronously.
 *
 * Latency model: at most ONE update in flight per planet. While a request is
 * outstanding, the latest camera is coalesced (overwrites the pending slot); on the
 * matching result it is re-dispatched if the camera moved. A monotonic `gen`
 * correlates results and lets late/stale results (after dispose) be dropped.
 */
import type { EmitResult } from '../cbt_emit';
import type {
    CbtFrameParams,
    CbtGeometryListener,
    CbtGeometrySource,
    CbtSourceStats,
} from '../cbt_geometry_source';
import type { NoiseParams } from '../cbt_noise';
import {
    CbtKernelClient,
    type CbtCreatePayload,
} from './cbt_kernel_client';
import {
    CBT_PARAMS_BASE_LEN,
    CBT_PARAMS_WITH_FRUSTUM_LEN,
    type CbtGeometryStats,
} from './cbt_worker_protocol';

export type WorkerCbtSourceOptions = {
    key: string;
    radiusSim: number;
    maxDepth: number;
    maxSplitsPerFrame: number;
    maxMergesPerFrame: number;
    splitThresholdPx2: number;
    splitHysteresis: number;
    cullBackface: boolean;
    cullMinDot: number;
    frustumGuardScale: number;
    incrementalMesh: boolean;
    noise: NoiseParams;
    /**
     * Optional spawn frame the worker refines toward (off-thread) before sending
     * the first geometry, so the planet is not shown at minimum LOD initially.
     */
    prewarmFrame?: CbtFrameParams;
    /** Max prewarm iterations (worker stops early once a pass makes no progress). */
    prewarmMaxIters?: number;
};

/** Pack a frame into the flat Float64Array layout consumed by cbt_kernel.rs. */
function packFrame(frame: CbtFrameParams): {
    params: Float64Array;
    hasFrustum: boolean;
} {
    const hasFrustum = frame.frustumPlanes != null;
    const len = hasFrustum ? CBT_PARAMS_WITH_FRUSTUM_LEN : CBT_PARAMS_BASE_LEN;
    const p = new Float64Array(len);
    const cam = frame.cameraWorldDouble;
    const c = frame.planetCenterWorldDouble;
    p[0] = cam.x;
    p[1] = cam.y;
    p[2] = cam.z;
    p[3] = c.x;
    p[4] = c.y;
    p[5] = c.z;
    const m = frame.renderParentWorldMatrix.m;
    for (let i = 0; i < 16; i++) p[6 + i] = m[i];
    // focal computed on the main thread (JS Math.tan) so the worker never calls tan
    // — keeps split decisions bit-identical to the synchronous reference path.
    p[22] = frame.viewportHeightPx / (2 * Math.tan(frame.cameraFovRadians * 0.5));
    p[23] = 0; // reserved
    if (hasFrustum && frame.frustumPlanes) {
        for (let i = 0; i < 6; i++) {
            const pl = frame.frustumPlanes[i];
            const o = 24 + i * 4;
            p[o] = pl.normal.x;
            p[o + 1] = pl.normal.y;
            p[o + 2] = pl.normal.z;
            p[o + 3] = pl.d;
        }
    }
    return { params: p, hasFrustum };
}

function toSourceStats(stats: CbtGeometryStats): CbtSourceStats {
    return {
        leafCount: stats.leafCount,
        splitsThisFrame: stats.splitsThisFrame,
        mergesThisFrame: stats.mergesThisFrame,
        classifyMs: stats.classifyMs,
        emitMs: stats.emitMs,
    };
}

export function buildCreatePayload(opts: WorkerCbtSourceOptions): CbtCreatePayload {
    const payload: CbtCreatePayload = {
        key: opts.key,
        radiusSim: opts.radiusSim,
        maxDepth: opts.maxDepth,
        splitThresholdPx2: opts.splitThresholdPx2,
        splitHysteresis: opts.splitHysteresis,
        maxSplitsPerFrame: opts.maxSplitsPerFrame,
        maxMergesPerFrame: opts.maxMergesPerFrame,
        cullBackface: opts.cullBackface,
        cullMinDot: opts.cullMinDot,
        frustumGuardScale: opts.frustumGuardScale,
        incrementalMesh: opts.incrementalMesh,
        noise: {
            seed: opts.noise.seed,
            octaves: opts.noise.octaves,
            baseFrequency: opts.noise.baseFrequency,
            baseAmplitude: opts.noise.baseAmplitude,
            lacunarity: opts.noise.lacunarity,
            persistence: opts.noise.persistence,
            globalAmplitude: opts.noise.globalAmplitude,
        },
    };
    if (opts.prewarmFrame) {
        const { params, hasFrustum } = packFrame(opts.prewarmFrame);
        payload.prewarm = {
            params,
            hasFrustum: hasFrustum ? 1 : 0,
            maxIters: opts.prewarmMaxIters ?? 1000,
        };
    }
    return payload;
}

export class WorkerCbtSource implements CbtGeometrySource {
    private readonly key: string;
    private gen = 0;
    private inFlight = false;
    private pendingParams: Float64Array | null = null;
    private pendingHasFrustum = false;
    private disposed = false;

    constructor(
        private readonly client: CbtKernelClient,
        opts: WorkerCbtSourceOptions,
        private readonly listener: CbtGeometryListener
    ) {
        this.key = opts.key;
        this.client.subscribe(this.key, this.onResult);
        this.client.createPlanet(buildCreatePayload(opts));
    }

    refresh(): void {
        // Initial mesh is produced by the worker (create_planet's prewarm result, or
        // the first update_planet round-trip). Nothing to do synchronously here.
    }

    requestUpdate(frame: CbtFrameParams): void {
        if (this.disposed) return;
        const { params, hasFrustum } = packFrame(frame);
        if (this.inFlight) {
            this.pendingParams = params;
            this.pendingHasFrustum = hasFrustum;
            return;
        }
        this.dispatch(params, hasFrustum);
    }

    reset(): void {
        if (this.disposed) return;
        this.client.resetPlanet(this.key);
    }

    dispose(): void {
        this.disposed = true;
        this.client.disposePlanet(this.key);
    }

    private dispatch(params: Float64Array, hasFrustum: boolean): void {
        this.inFlight = true;
        this.gen += 1;
        this.client.update(this.key, this.gen, params, hasFrustum);
    }

    private onResult = (
        gen: number,
        geometry: EmitResult | null,
        stats: CbtGeometryStats
    ): void => {
        if (this.disposed) return;
        // Single-in-flight: a result older than the last dispatched gen is stale
        // (e.g. the create_planet prewarm result, gen 0). Still surface its geometry
        // so the planet appears, but only clear the in-flight slot on the match.
        this.listener(geometry, toSourceStats(stats));
        if (gen >= this.gen) {
            this.inFlight = false;
            if (this.pendingParams) {
                const params = this.pendingParams;
                const hasFrustum = this.pendingHasFrustum;
                this.pendingParams = null;
                this.dispatch(params, hasFrustum);
            }
        }
    };
}
