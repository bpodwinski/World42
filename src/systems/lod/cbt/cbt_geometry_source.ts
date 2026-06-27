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

/** Called when a source produces an update. `geometry` is null when the tree did not change. */
export type CbtGeometryListener = (
    geometry: EmitResult | null,
    stats: CbtSourceStats
) => void;

/** Produces CBT mesh geometry for one planet. Owns classify + split/merge + emit; caller owns the Babylon mesh upload. */
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
    /** Optional: enable/disable the mesh draw (off-screen frustum cull on a source that owns its mesh). */
    setVisible?(on: boolean): void;
    dispose(): void;
}

