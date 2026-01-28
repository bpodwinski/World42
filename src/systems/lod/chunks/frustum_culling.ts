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
    isSphereInFrustum: (centerRender: Vector3, radius: number, planes: Plane[]) => boolean): boolean {
    const frustumPlanes: Plane[] = Array.from({ length: 6 }, () => new PlaneValue(0, 0, 0, 0));
    camera.getFrustumPlanesToRef(frustumPlanes);

    const centerRender = new Vector3Value();
    camera.toRenderSpace(centerWorld as any, centerRender);

    return isSphereInFrustum(centerRender as any, radius, frustumPlanes);
}
