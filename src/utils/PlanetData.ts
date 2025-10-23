import { Vector3 } from "@babylonjs/core";
import { ScaleManager } from "../core/ScaleManager";
import planetsJson from "../var/planets.json";

/**
 * Planet data in simulation units: Includes position, diameter, and rotation speed (rad/s)
 */
export type PlanetInfo = {
    /** Position in simulation space (converted to simulation units) */
    position: Vector3;

    /** Diameter in simulation units */
    diameter: number;

    /** Rotation speed in radians per second */
    rotationSpeed: number;
};

type PlanetJson = {
    /** Position in kilometers: [x, y, z] */
    position_km: number[];

    /** Diameter in kilometers */
    diameter_km: number;

    /** Rotation period in days (null => 0 rad/s) */
    rotation_period_days: number | null;
};

type PlanetMapJson = Record<string, PlanetJson>;

/** Convert raw JSON entry to PlanetInfo (unit conversion included) */
function toPlanetInfo(pj: PlanetJson): PlanetInfo {
    const posKm = new Vector3(pj.position_km[0], pj.position_km[1], pj.position_km[2]);
    const position = ScaleManager.toSimulationVector(posKm);
    const diameter = ScaleManager.toSimulationUnits(pj.diameter_km);
    const rotationSpeed =
        pj.rotation_period_days && pj.rotation_period_days !== 0
            ? (2 * Math.PI) / (pj.rotation_period_days * 86400)
            : 0;

    return { position, diameter, rotationSpeed };
}

/**
 * Centralized registry for multiple celestial bodies. Provides static accessors for planet data
 */
export class PlanetData {
    public static planets: Record<string, PlanetInfo> = (() => {
        const entries = Object.entries(planetsJson as PlanetMapJson).map(([name, pj]) => {
            const info = toPlanetInfo(pj);

            console.info(`[PlanetData] loaded: ${name}`);

            return [name, info] as const;
        });

        console.info(`[PlanetData] total loaded: ${entries.length}`);

        return Object.fromEntries(entries);
    })();

    /**
     * Get planet data by name
     *
     * @param planetName - e.g. "Mercury", "Earth", etc.
     * @returns PlanetInfo for the requested body
     */
    public static get(planetName: keyof typeof PlanetData.planets): PlanetInfo {
        const data = PlanetData.planets[planetName];

        //console.info(`[PlanetData] get: ${String(planetName)}`);

        return data;
    }
}
