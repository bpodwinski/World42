import { Matrix, Vector3 } from '@babylonjs/core';
import type { CbtClassifyParams } from '../cbt_classify';
import { CbtState, type CbtNode } from '../cbt_state';

/**
 * Deterministic CBT fixtures shared by benchmarks and regression tests.
 *
 * Everything here is seedless and platform-stable: no time, no RNG. Two calls
 * with the same arguments always produce byte-identical structures, which is
 * what makes the golden tests and before/after benchmarks meaningful.
 */

/** Default radius used across fixtures (sim units). */
export const FIXTURE_RADIUS = 1000;

/** Default maxDepth — deep enough that fixtures never hit the depth cap. */
export const FIXTURE_MAX_DEPTH = 24;

/**
 * Grow a {@link CbtState} to at least `targetLeaves` leaves via uniform
 * breadth-first splitting (every current leaf is split once per round, so the
 * leaf count roughly doubles each round). Deterministic and balanced.
 *
 * The last round is capped so the final leaf count lands as close to
 * `targetLeaves` as a single split granularity allows.
 */
export function growUniform(
    targetLeaves: number,
    radius: number = FIXTURE_RADIUS,
    maxDepth: number = FIXTURE_MAX_DEPTH
): CbtState {
    const state = new CbtState(radius, maxDepth);
    while (state.leafCount < targetLeaves) {
        const before = state.leafCount;
        const ids = state.getLeafNodes().map((leaf) => leaf.id);
        // Each split adds exactly one leaf; cap the round so we don't overshoot.
        const room = targetLeaves - before;
        const maxSplits = room < ids.length ? room : ids.length;
        state.splitByPriority(ids, maxSplits);
        if (state.leafCount === before) break; // maxDepth reached — avoid spinning
    }
    return state;
}

/** Convenience: a uniform leaf set of approximately `targetLeaves` triangles. */
export function makeLeafSet(
    targetLeaves: number,
    radius: number = FIXTURE_RADIUS,
    maxDepth: number = FIXTURE_MAX_DEPTH
): CbtNode[] {
    return growUniform(targetLeaves, radius, maxDepth).getLeafNodes();
}

export type ClassifyFixtureOpts = {
    /** Camera distance from planet center, in sim units (default: 1.5 × radius). */
    cameraDistance?: number;
    /** Viewport height in pixels (default 1080). */
    viewportHeightPx?: number;
    /** Camera vertical FOV in radians (default 1.2). */
    cameraFovRadians?: number;
    splitThresholdPx2?: number;
    splitHysteresis?: number;
};

/**
 * Build a stable {@link CbtClassifyParams} for a leaf set, with the camera
 * placed on the +Z axis looking at a planet centered at the origin. The render
 * parent matrix is identity, so planet-local == render-space for the fixture.
 */
export function makeClassifyParams(
    leaves: ReadonlyArray<CbtNode>,
    radius: number = FIXTURE_RADIUS,
    opts: ClassifyFixtureOpts = {}
): CbtClassifyParams {
    const {
        cameraDistance = radius * 1.5,
        viewportHeightPx = 1080,
        cameraFovRadians = 1.2,
        splitThresholdPx2 = 900,
        splitHysteresis = 0.75,
    } = opts;

    return {
        leaves,
        cameraWorldDouble: new Vector3(0, 0, cameraDistance),
        planetCenterWorldDouble: Vector3.Zero(),
        renderParentWorldMatrix: Matrix.Identity(),
        viewportHeightPx,
        cameraFovRadians,
        splitThresholdPx2,
        splitHysteresis,
    };
}
