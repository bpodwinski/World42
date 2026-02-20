import type { Plane, Vector3 } from "@babylonjs/core";

/**
 * Fast conservative shadow relevance test.
 *
 * Builds an approximated swept sphere (capsule) from `centerWorld` to
 * `centerWorld - lightDir * maxShadowCastDistance` and tests it against camera frustum planes.
 *
 * Returns `true` when the capsule may intersect the frustum (potential shadow caster).
 */
export function isShadowRelevant(
    centerWorld: Vector3,
    radius: number,
    lightDir: Vector3,
    cameraFrustumPlanes: Plane[],
    maxShadowCastDistance: number
): boolean {
    const ldLen2 = lightDir.lengthSquared();
    if (ldLen2 < 1e-12) return false;

    const invLdLen = 1 / Math.sqrt(ldLen2);
    const dirX = lightDir.x * invLdLen;
    const dirY = lightDir.y * invLdLen;
    const dirZ = lightDir.z * invLdLen;

    const sweep = Math.max(0, maxShadowCastDistance);

    const endX = centerWorld.x - dirX * sweep;
    const endY = centerWorld.y - dirY * sweep;
    const endZ = centerWorld.z - dirZ * sweep;

    for (const p of cameraFrustumPlanes) {
        const ds = p.normal.x * centerWorld.x + p.normal.y * centerWorld.y + p.normal.z * centerWorld.z + p.d;
        const de = p.normal.x * endX + p.normal.y * endY + p.normal.z * endZ + p.d;

        // If both capsule segment endpoints are outside the same plane by more than radius,
        // the whole capsule is outside that half-space.
        if (ds < -radius && de < -radius) {
            return false;
        }
    }

    return true;
}
