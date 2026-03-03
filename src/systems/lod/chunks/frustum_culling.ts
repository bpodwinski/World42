import type { Plane, Vector3 } from '@babylonjs/core';
import { Plane as PlaneValue, Vector3 as Vector3Value } from '@babylonjs/core';
import type { OriginCamera } from '../../../core/camera/camera_manager';

export type FrustumCullCache = {
    planes: Plane[];
    centerRender: Vector3;
};

export function createFrustumCullCache(): FrustumCullCache {
    return {
        planes: Array.from({ length: 6 }, () => new PlaneValue(0, 0, 0, 0)),
        centerRender: new Vector3Value(),
    };
}

export function frustumCulling(
    camera: OriginCamera,
    centerWorld: Vector3,
    radius: number,
    isSphereInFrustum: (centerRender: Vector3, radius: number, planes: Plane[]) => boolean,
    cache: FrustumCullCache
): boolean {
    camera.getFrustumPlanesToRef(cache.planes);
    camera.toRenderSpace(centerWorld, cache.centerRender);
    return isSphereInFrustum(cache.centerRender, radius, cache.planes);
}

export function frustumCullingWithPlanes(
    camera: OriginCamera,
    frustumPlanes: Plane[],
    centerWorld: Vector3,
    radius: number,
    isSphereInFrustum: (centerRender: Vector3, radius: number, planes: Plane[]) => boolean,
    cache: FrustumCullCache
): boolean {
    camera.toRenderSpace(centerWorld, cache.centerRender);
    return isSphereInFrustum(cache.centerRender, radius, frustumPlanes);
}
