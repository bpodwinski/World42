import type { Plane, Vector3 } from "@babylonjs/core";
import { Plane as PlaneValue, Vector3 as Vector3Value } from "@babylonjs/core";
import type { OriginCamera } from "../../../core/camera/camera_manager";

/**
 * Frustum culling for a chunk using a bounding sphere.
 * Builds the camera frustum planes, converts the chunk center to render space,
 * then tests the sphere against the planes.
 *
 * @param camera OriginCamera providing frustum planes and world->render conversion
 * @param centerWorld Chunk center in world/double space
 * @param radius Bounding sphere radius in world units
 * @param isSphereInFrustum Sphere vs frustum test (returns true if visible)
 * @returns True if the chunk sphere is inside/intersecting the frustum; false if culled
 */
export function frustumCulling(
    camera: OriginCamera,
    centerWorld: Vector3,
    radius: number,
    isSphereInFrustum: (centerRender: Vector3, radius: number, planes: Plane[]) => boolean,
    cache: FrustumCullCache): boolean {
    camera.getFrustumPlanesToRef(cache.planes);
    camera.toRenderSpace(centerWorld as any, cache.centerRender as any);
    return isSphereInFrustum(cache.centerRender as any, radius, cache.planes);
}

type FrustumCullCache = {
    planes: Plane[];
    centerRender: Vector3;
};

export function createFrustumCullCache(): FrustumCullCache {
    return {
        planes: Array.from({ length: 6 }, () => new PlaneValue(0, 0, 0, 0)),
        centerRender: new Vector3Value(),
    };
}