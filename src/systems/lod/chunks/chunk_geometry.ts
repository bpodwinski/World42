import { Matrix, Vector3 } from "@babylonjs/core";
import { Terrain } from "../../../game_objects/planets/rocky_planet/terrain";
import type { Bounds, Face } from "../types";

export type ChunkBaseGeometry = {
    /** Patch center on base sphere in planet-local */
    centerLocal: Vector3;
    /** Patch corners on base sphere in planet-local (order is stable) */
    cornersLocal: [Vector3, Vector3, Vector3, Vector3];
};

/**
 * Precompute center/corners on the base sphere (planet-local).
 * Bounds are in tan(angle) space; center is computed in angle-space (atan/tan) for uniformity.
 */
export function buildBaseGeometry(bounds: Bounds, face: Face, radius: number): ChunkBaseGeometry {
    const { uMin, uMax, vMin, vMax } = bounds;

    const aUMin = Math.atan(uMin), aUMax = Math.atan(uMax);
    const aVMin = Math.atan(vMin), aVMax = Math.atan(vMax);

    const uCenter = Math.tan((aUMin + aUMax) * 0.5);
    const vCenter = Math.tan((aVMin + aVMax) * 0.5);

    const centerLocal = Terrain.mapUVtoCube(uCenter, vCenter, face).normalize().scale(radius);

    const c0 = Terrain.mapUVtoCube(uMin, vMin, face).normalize().scale(radius);
    const c1 = Terrain.mapUVtoCube(uMin, vMax, face).normalize().scale(radius);
    const c2 = Terrain.mapUVtoCube(uMax, vMin, face).normalize().scale(radius);
    const c3 = Terrain.mapUVtoCube(uMax, vMax, face).normalize().scale(radius);

    return { centerLocal, cornersLocal: [c0, c1, c2, c3] };
}

/**
 * local planet -> rotated by renderParent (worldMatrix) -> WorldDouble (planetCenterWorldDouble + rotatedLocal)
 * Uses TransformNormal (ignores translation).
 */
export function localToWorldDouble(
    local: Vector3,
    worldMatrix: Matrix,
    planetCenterWorldDouble: Vector3,
    out: Vector3
): Vector3 {
    Vector3.TransformNormalToRef(local, worldMatrix, out);
    out.addInPlace(planetCenterWorldDouble);
    return out;
}