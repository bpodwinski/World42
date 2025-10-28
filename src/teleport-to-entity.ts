import { Vector3 } from "@babylonjs/core";
import { OriginCamera } from "./core/camera/camera-manager";
import { ScaleManager } from "./core/scale/scale-manager";

type HasDoublePos = { doublepos: Vector3 };
type HasPosition = { position: Vector3 };

/**
 * Place la caméra à altitudeKm au-dessus de la surface, alignée sur la direction actuelle.
 * `target` peut être un FloatingEntity (doublepos), un TransformNode (position) ou un Vector3.
 */
export function teleportToEntity(
    camera: OriginCamera,
    target: HasDoublePos | HasPosition | Vector3,
    planetDiameterKm: number,
) {
    // 1) Résoudre la position "monde"
    const camPos: Vector3 = (camera as any).doublepos ?? camera.position;
    let tgtPos: Vector3 | undefined;

    if ((target as HasDoublePos).doublepos) {
        tgtPos = (target as HasDoublePos).doublepos;
    } else if ((target as HasPosition).position) {
        tgtPos = (target as HasPosition).position;
        console.warn(
            "[teleportToEntity] target n'a pas de doublepos; fallback sur .position (rendu). " +
            "En floating-origin, préférez un FloatingEntity avec .doublepos."
        );
    } else if (target instanceof Vector3) {
        tgtPos = target;
    }

    if (!camPos || !tgtPos) {
        console.error("[teleportToEntity] Caméra ou cible sans position valide.", { camPos, tgtPos, target });
        return;
    }

    // 2) Convertir km -> unités simulation
    const radiusSim = ScaleManager.toSimulationUnits(planetDiameterKm) * 0.5;
    const altSim = ScaleManager.kmToMeters(planetDiameterKm) * 1.05;

    // 3) Direction planète -> caméra
    let dir = camPos.subtract(tgtPos);
    if (dir.lengthSquared() < 1e-12) dir = new Vector3(0, 1, 0);
    dir.normalize();

    // 4) Nouvelle position haute précision
    const targetDoublePos = tgtPos.add(dir.scale(radiusSim + altSim));

    // 5) Appliquer (double précision) + regarder la planète
    (camera as any).doublepos?.copyFrom
        ? (camera as any).doublepos.copyFrom(targetDoublePos)
        : camera.position.copyFrom(targetDoublePos); // fallback

    if ((camera as any).doubletgt) {
        (camera as any).doubletgt.copyFrom(tgtPos);
    } else {
        camera.setTarget(tgtPos);
    }
}
