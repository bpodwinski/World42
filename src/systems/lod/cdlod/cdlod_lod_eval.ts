import type { Vector3 } from "@babylonjs/core";
import { computeSSEPxFast, estimatePatchWorldSize4 } from "./cdlod_metrics";

export type LodDecision = {
    ssePx: number;
    shouldSplit: boolean;
    shouldMerge: boolean;
};

export type LodMorphArgs = {
    ssePx: number;
    splitTh: number;
    mergeTh: number;
    morphStart?: number;
    morphEnd?: number;
};

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

function smoothstep01(t: number): number {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
}

/**
 * Compute CDLOD geomorph factor from SSE with a transition window.
 *
 * @remarks
 * - Returns `0` near split threshold (keep full-detail shape).
 * - Returns `1` near/under merge threshold (morph toward parent-like shape).
 * - Applies a configurable window and smoothstep easing to reduce popping.
 */
export function computeLodMorphFactor(args: LodMorphArgs): number {
    const den = Math.max(1e-6, args.splitTh - args.mergeTh);
    const normalized = (args.splitTh - args.ssePx) / den; // split->0, merge->1

    const start = args.morphStart ?? 0.35;
    const end = args.morphEnd ?? 0.65;
    const window = Math.max(1e-6, end - start);
    const t = (normalized - start) / window;
    return smoothstep01(t);
}

export function evalLodDecision(args: {
    cornersWorld: readonly Vector3[];
    distanceToPatch: number;

    resolution: number;
    level: number;
    maxLevel: number;

    splitTh: number;
    mergeTh: number;

    geomErrorScale: number;
    minDistEpsilon: number;

    /** K = viewportH / (2*tan(fov/2)) precomputed per frame */
    sseK: number;
}): LodDecision {
    const patchSize = estimatePatchWorldSize4(args.cornersWorld);

    const ssePx = computeSSEPxFast({
        patchSize,
        resolution: args.resolution,
        geomErrorScale: args.geomErrorScale,
        distanceToPatch: args.distanceToPatch,
        minDistEpsilon: args.minDistEpsilon,
        sseK: args.sseK,
    });

    const shouldSplit = (ssePx > args.splitTh) && (args.level < args.maxLevel);
    const shouldMerge = (ssePx < args.mergeTh);

    return { ssePx, shouldSplit, shouldMerge };
}
