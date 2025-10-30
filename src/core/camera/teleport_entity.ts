import { Vector3 } from "@babylonjs/core";
import { OriginCamera } from "./camera_manager";
import { ScaleManager } from "../scale/scale_manager";

type HasDoublePos = { doublepos: Vector3 };
type HasPosition = { position: Vector3 };

/**
 * Teleports the camera to a point above a target entity, aligned along the current direction from the target to the camera, at a given percentage of the planet diameter.
 *
 * @param camera - Floating-origin aware camera (`OriginCamera`). If it exposes `doublepos`/`doubletgt`, they will be used for high precision; otherwise falls back to `position`/`setTarget`.
 * @param target - Destination anchor: `{ doublepos }`, `{ position }`, or a `Vector3`.
 * @param planetDiameter - Planet diameter (source units expected by `ScaleManager.toSimulationUnits`, typically kilometers).
 * @param diameterOffsetPercent - Percentage of the planet diameter to add along the outward direction.
 */
export function teleportToEntity(
    camera: OriginCamera,
    target: HasDoublePos | HasPosition | Vector3,
    planetDiameter: number,
    diameterOffsetPercent: number
) {
    // Resolve "world" (high-precision if available) camera position
    const camPos: Vector3 = (camera as any).doublepos ?? camera.position;
    let tgtPos: Vector3 | undefined;

    if ((target as HasDoublePos).doublepos) {
        tgtPos = (target as HasDoublePos).doublepos;
    } else if ((target as HasPosition).position) {
        tgtPos = (target as HasPosition).position;
        console.warn(
            "[teleportToEntity] target has no `doublepos`; falling back to `.position` (render-space). " +
            "For floating-origin, prefer a FloatingEntity exposing `.doublepos`."
        );
    } else if (target instanceof Vector3) {
        tgtPos = target;
    }

    if (!camPos || !tgtPos) {
        console.error("[teleportToEntity] Camera or target has no valid position.", { camPos, tgtPos, target });
        return;
    }

    // Direction: planet/target → camera
    let dir = camPos.subtract(tgtPos);
    if (dir.lengthSquared() < 1e-12) dir = new Vector3(0, 1, 0); // avoid zero-length vector
    dir.normalize();

    // Compute altitude factor from percentage (e.g., 5 → 1.05)
    const diameterOffset = 1 + diameterOffsetPercent / 100;

    // New high-precision camera position
    const targetDoublePos = tgtPos.add(
        dir.scale(ScaleManager.toSimulationUnits(planetDiameter * diameterOffset))
    );

    // Apply high-precision position (or fallback to standard position)
    (camera as any).doublepos?.copyFrom
        ? (camera as any).doublepos.copyFrom(targetDoublePos)
        : camera.position.copyFrom(targetDoublePos);

    // Look at the target using high-precision target if available
    if ((camera as any).doubletgt) {
        (camera as any).doubletgt.copyFrom(tgtPos);
    } else {
        camera.setTarget(tgtPos);
    }
}
