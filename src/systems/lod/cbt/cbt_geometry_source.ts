import { Matrix, Plane, Vector3 } from '@babylonjs/core';
import { classifyLeaves } from './cbt_classify';
import { CbtEmitCache, emitMeshFromLeaves, type EmitResult } from './cbt_emit';
import type { NoiseParams } from './cbt_noise';
import { CbtState } from './cbt_state';

/**
 * Per-frame camera inputs a source needs to classify the tree. These are the
 * exact values {@link classifyLeaves} consumes (the per-planet constants like
 * thresholds and noise live on the source itself, not here).
 */
export type CbtFrameParams = {
    cameraWorldDouble: Vector3;
    planetCenterWorldDouble: Vector3;
    renderParentWorldMatrix: Matrix;
    viewportHeightPx: number;
    cameraFovRadians: number;
    frustumPlanes: ReadonlyArray<Plane> | null;
};

export type CbtSourceStats = {
    leafCount: number;
    splitsThisFrame: number;
    mergesThisFrame: number;
    /** Wall-clock ms for classify + split + merge (no emit). */
    classifyMs: number;
    /** Wall-clock ms for the emit (0 when nothing was re-emitted). */
    emitMs: number;
};

/**
 * Called when a source produces an update. `geometry` is null when the tree did
 * not change (no re-emit). {@link LocalCbtSource} calls this synchronously inside
 * `requestUpdate`/`refresh`; the worker source (Phase 3) calls it later, on
 * message receipt.
 */
export type CbtGeometryListener = (
    geometry: EmitResult | null,
    stats: CbtSourceStats
) => void;

/**
 * Produces CBT mesh geometry for one planet. The geometry source owns the tree
 * logic (classify + split/merge + emit + noise); the caller ({@link CbtPlanet})
 * owns only the Babylon mesh upload (`applyToMesh`). Two implementations:
 *  - {@link LocalCbtSource}: all work on the main thread (reference path + golden).
 *  - WorkerCbtSource (Phase 3): the same work in a Rust/WASM worker, async.
 */
export interface CbtGeometrySource {
    /** Emit the current tree (no classify/split/merge) — initial mesh / full refresh. */
    refresh(): void;
    /** Classify + split + merge for this frame; emit only if the topology changed. */
    requestUpdate(frame: CbtFrameParams): void;
    /** Defer a full re-emit to the next update (mirrors CbtPlanet.resetNow). */
    reset(): void;
    /** Optional: toggle wireframe on a source that owns its own material (GPU path). */
    setWireframe?(on: boolean): void;
    /** Optional: toggle per-LOD-level debug colors on a source that owns its material (GPU path). */
    setDebugLod?(on: boolean): void;
    dispose(): void;
}

export type LocalCbtSourceOptions = {
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
};

/**
 * Main-thread CBT geometry source: owns a {@link CbtState} tree and a
 * {@link CbtEmitCache}, running classify/split/merge/emit synchronously. This is
 * the exact pipeline that previously lived inline in `CbtPlanet.update`, so its
 * behavior is byte-for-byte identical (golden + invariant tests cover it).
 */
export class LocalCbtSource implements CbtGeometrySource {
    private readonly state: CbtState;
    private readonly emitCache = new CbtEmitCache();
    private pendingFullRefresh = true;

    constructor(
        private readonly opts: LocalCbtSourceOptions,
        private readonly listener: CbtGeometryListener
    ) {
        this.state = new CbtState(opts.radiusSim, opts.maxDepth);
    }

    refresh(): void {
        const emitStart = performance.now();
        const geometry = this.emit();
        const emitMs = performance.now() - emitStart;
        this.pendingFullRefresh = false;
        this.listener(geometry, {
            leafCount: this.state.leafCount,
            splitsThisFrame: 0,
            mergesThisFrame: 0,
            classifyMs: 0,
            emitMs,
        });
    }

    requestUpdate(frame: CbtFrameParams): void {
        const classifyStart = performance.now();
        const leaves = this.state.getLeafNodes();
        const { splitCandidates, mergeParents } = classifyLeaves({
            leaves,
            cameraWorldDouble: frame.cameraWorldDouble,
            planetCenterWorldDouble: frame.planetCenterWorldDouble,
            renderParentWorldMatrix: frame.renderParentWorldMatrix,
            viewportHeightPx: frame.viewportHeightPx,
            cameraFovRadians: frame.cameraFovRadians,
            splitThresholdPx2: this.opts.splitThresholdPx2,
            splitHysteresis: this.opts.splitHysteresis,
            cullBackface: this.opts.cullBackface,
            cullMinDot: this.opts.cullMinDot,
            frustumPlanes: frame.frustumPlanes,
            frustumGuardScale: this.opts.frustumGuardScale,
        });

        const splitCount = this.state.splitByPriority(
            splitCandidates.map((candidate) => candidate.nodeId),
            this.opts.maxSplitsPerFrame
        );
        const mergeCount = this.state.mergeByParentPriority(
            mergeParents,
            this.opts.maxMergesPerFrame
        );
        const classifyMs = performance.now() - classifyStart;

        let geometry: EmitResult | null = null;
        let emitMs = 0;
        if (splitCount > 0 || mergeCount > 0 || this.pendingFullRefresh) {
            const emitStart = performance.now();
            geometry = this.emit();
            emitMs = performance.now() - emitStart;
            this.pendingFullRefresh = false;
        }

        this.listener(geometry, {
            leafCount: this.state.leafCount,
            splitsThisFrame: splitCount,
            mergesThisFrame: mergeCount,
            classifyMs,
            emitMs,
        });
    }

    reset(): void {
        this.pendingFullRefresh = true;
    }

    dispose(): void {
        // Holds no GPU/Babylon resources; nothing to free.
    }

    private emit(): EmitResult {
        const leaves = this.state.getLeafNodes();
        return this.opts.incrementalMesh
            ? this.emitCache.emit(leaves, this.opts.radiusSim, { noise: this.opts.noise })
            : emitMeshFromLeaves(leaves, this.opts.radiusSim, { noise: this.opts.noise });
    }
}
