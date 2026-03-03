import { Vector3 } from '@babylonjs/core';
import { OriginCamera } from './camera_manager';

type HasDoublePos = { doublepos: Vector3 };
type HasPosition = { position: Vector3 };

function hasDoublePos(value: unknown): value is HasDoublePos {
    return !!value && typeof value === 'object' && 'doublepos' in value;
}

function hasPosition(value: unknown): value is HasPosition {
    return !!value && typeof value === 'object' && 'position' in value;
}

function resolveTargetPosition(target: HasDoublePos | HasPosition | Vector3): Vector3 | null {
    if (target instanceof Vector3) return target;
    if (hasDoublePos(target)) return target.doublepos;
    if (hasPosition(target)) return target.position;
    return null;
}

/**
 * Teleports camera above a target along the current target->camera direction.
 */
export function teleportToEntity(
    camera: OriginCamera,
    target: HasDoublePos | HasPosition | Vector3,
    planetDiameter: number,
    diameterOffsetPercent: number
): void {
    const cameraPos = camera.doublepos;
    const targetPos = resolveTargetPosition(target);
    if (!targetPos) {
        console.error('[teleportToEntity] Invalid target position.', { target });
        return;
    }

    let direction = cameraPos.subtract(targetPos);
    if (direction.lengthSquared() < 1e-12) {
        direction = Vector3.Up();
    } else {
        direction.normalize();
    }

    const diameterOffset = 1 + diameterOffsetPercent / 100;
    const distanceFromCenter = planetDiameter * 0.5 * diameterOffset;
    const targetCameraPos = targetPos.add(direction.scale(distanceFromCenter));

    camera.doublepos.copyFrom(targetCameraPos);
    camera.doubletgt.copyFrom(targetPos);
    const targetRender = new Vector3();
    camera.toRenderSpace(targetPos, targetRender);
    camera.setTarget(targetRender);
}
