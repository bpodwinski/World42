import type { Plane, Vector3 } from "@babylonjs/core";
import { Plane as PlaneValue, Vector3 as Vector3Value } from "@babylonjs/core";
import type { OriginCamera } from "../../../core/camera/camera_manager";

/**
 * Per-node cache for frustum culling.
 *
 * Notes:
 * - Babylon expects an array of **6 pre-allocated Plane instances** when calling
 *   `camera.getFrustumPlanesToRef(...)`.
 * - `centerRender` is a scratch vector used to avoid allocations when converting
 *   from WorldDouble to Render-space.
 */
export type FrustumCullCache = {
    /** Scratch array for camera frustum planes (length = 6). */
    planes: Plane[];

    /** Scratch center in Render-space (floating origin). */
    centerRender: Vector3;
};

/**
 * Create a reusable frustum culling cache.
 *
 * @returns A cache containing 6 pre-allocated planes and a scratch render-space vector.
 */
export function createFrustumCullCache(): FrustumCullCache {
    return {
        planes: Array.from({ length: 6 }, () => new PlaneValue(0, 0, 0, 0)),
        centerRender: new Vector3Value(),
    };
}

/**
 * Legacy frustum culling helper (recomputes planes every call).
 *
 * Coordinate spaces:
 * - `centerWorld` is expected in WorldDouble
 * - `centerRender` is computed in Render-space via `camera.toRenderSpace`
 *
 * Prefer `frustumCullingWithPlanes(...)` when frustum planes are computed once per frame.
 *
 * @param camera Origin camera providing frustum planes and WorldDouble->Render conversion.
 * @param centerWorld Bounding sphere center in WorldDouble.
 * @param radius Bounding sphere radius.
 * @param isSphereInFrustum Predicate testing a render-space sphere against planes.
 * @param cache Reusable cache to avoid allocations.
 */
export function frustumCulling(
    camera: OriginCamera,
    centerWorld: Vector3,
    radius: number,
    isSphereInFrustum: (centerRender: Vector3, radius: number, planes: Plane[]) => boolean,
    cache: FrustumCullCache
): boolean {
    camera.getFrustumPlanesToRef(cache.planes);
    camera.toRenderSpace(centerWorld as any, cache.centerRender as any);
    return isSphereInFrustum(cache.centerRender as any, radius, cache.planes);
}

/**
 * Fast frustum culling helper where planes are provided by the caller (typically 1×/frame).
 *
 * Coordinate spaces:
 * - `centerWorld` is expected in WorldDouble
 * - `centerRender` is computed in Render-space via `camera.toRenderSpace`
 *
 * @param camera Origin camera providing WorldDouble->Render conversion.
 * @param frustumPlanes Precomputed frustum planes (length = 6).
 * @param centerWorld Bounding sphere center in WorldDouble.
 * @param radius Bounding sphere radius.
 * @param isSphereInFrustum Predicate testing a render-space sphere against planes.
 * @param cache Reusable cache to avoid allocations.
 */
export function frustumCullingWithPlanes(
    camera: OriginCamera,
    frustumPlanes: Plane[],
    centerWorld: Vector3,
    radius: number,
    isSphereInFrustum: (centerRender: Vector3, radius: number, planes: Plane[]) => boolean,
    cache: FrustumCullCache
): boolean {
    camera.toRenderSpace(centerWorld as any, cache.centerRender as any);
    return isSphereInFrustum(cache.centerRender as any, radius, frustumPlanes);
}
