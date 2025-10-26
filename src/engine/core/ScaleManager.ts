import { Vector3 } from "@babylonjs/core";

/**
 * ScaleManager converts between real-world units and simulation units
 */
export class ScaleManager {
    /** Kilometers -> Simulation Units factor */
    private static readonly SCALE_FACTOR: number = Number(process.env.SCALE_FACTOR ?? 1);

    // ==========
    // Distances
    // ==========

    /**
     * Converts a distance from kilometers to simulation units
     *
     * @param value_km - The distance in kilometers
     * @returns The equivalent distance in simulation units
     */
    public static toSimulationUnits(value_km: number): number {
        return value_km * this.SCALE_FACTOR;
    }

    /** sim units -> km (scalar) */
    public static toRealUnits(simUnits: number): number {
        return simUnits / this.SCALE_FACTOR;
    }

    /**
     * Converts a position vector from kilometers to simulation units
     *
     * @param position_km - The position vector in kilometers
     * @returns A new Vector3 representing the position in simulation units
     */
    public static toSimulationVector(position_km: Vector3): Vector3 {
        return position_km.scale(this.SCALE_FACTOR);
    }

    /** Vector (sim units) -> km */
    public static toRealVector(posSim: Vector3): Vector3 {
        return posSim.scale(1 / this.SCALE_FACTOR);
    }

    /** Convenience: km -> meters */
    public static kmToMeters(km: number): number {
        return km * 1000;
    }

    /** Convenience: meters -> km */
    public static metersToKm(m: number): number {
        return m / 1000;
    }

    // =========
    // Speeds
    // =========

    /**
     * Convert a speed from simulation units / s -> km / s
     * Use this when tu lis `camera.speedSim` ou `camera.velocitySim.length()`.
     */
    public static simSpeedToKmPerSec(simUnitsPerSec: number): number {
        return this.toRealUnits(simUnitsPerSec); // sim/s -> km/s
    }

    /** sim units / s -> m / s */
    public static simSpeedToMetersPerSec(simUnitsPerSec: number): number {
        return this.kmToMeters(this.simSpeedToKmPerSec(simUnitsPerSec));
    }

    /** km / s -> sim units / s */
    public static kmPerSecToSimSpeed(kmPerSec: number): number {
        return this.toSimulationUnits(kmPerSec);
    }

    /** m / s -> sim units / s */
    public static metersPerSecToSimSpeed(mPerSec: number): number {
        return this.kmPerSecToSimSpeed(this.metersToKm(mPerSec));
    }

    // ===============
    // Accelerations
    // ===============

    /** sim units / s² -> km / s² */
    public static simAccelToKmPerSec2(simUnitsPerSec2: number): number {
        return this.toRealUnits(simUnitsPerSec2);
    }

    /** sim units / s² -> m / s² */
    public static simAccelToMetersPerSec2(simUnitsPerSec2: number): number {
        return this.kmToMeters(this.simAccelToKmPerSec2(simUnitsPerSec2));
    }

    /** km / s² -> sim units / s² */
    public static kmPerSec2ToSimAccel(kmPerSec2: number): number {
        return this.toSimulationUnits(kmPerSec2);
    }

    /** m / s² -> sim units / s² */
    public static metersPerSec2ToSimAccel(mPerSec2: number): number {
        return this.kmPerSec2ToSimAccel(this.metersToKm(mPerSec2));
    }
}
