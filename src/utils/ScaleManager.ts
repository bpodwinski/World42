import { Vector3 } from "@babylonjs/core";

/**
 * ScaleManager class for converting real-world distances (in kilometers)
 * to simulation units used in Babylon.js.
 */
export class ScaleManager {
    private static readonly SCALE_FACTOR = 1;

    /**
     * Converts a distance from kilometers to simulation units.
     *
     * @param value_km - The distance in kilometers.
     * @returns The equivalent distance in simulation units.
     */
    public static toSimulationUnits(value_km: number): number {
        return value_km * this.SCALE_FACTOR;
    }

    /**
     * Converts a position vector from kilometers to simulation units.
     *
     * @param position_km - The position vector in kilometers.
     * @returns A new Vector3 representing the position in simulation units.
     */
    public static toSimulationVector(position_km: Vector3): Vector3 {
        return position_km.scale(this.SCALE_FACTOR);
    }
}
