import type { Vector3 } from "@babylonjs/core";
import { computeSSEPxFast, estimatePatchWorldSize4 } from "./chunk_metrics";

export type LodDecision = {
    ssePx: number;
    shouldSplit: boolean;
    shouldMerge: boolean;
};

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
