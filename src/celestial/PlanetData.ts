import { Vector3 } from "@babylonjs/core";
import { ScaleManager } from "../utils/ScaleManager";

/**
 * Définition du type contenant les informations d'une planète.
 */
export type PlanetInfo = {
    /** Position de la planète dans l'espace (convertie en unités de simulation) */
    position: Vector3;
    /** Diamètre de la planète en unités de simulation */
    diameter: number;
    /** Vitesse de rotation de la planète en radians par seconde */
    rotationSpeed: number;
};

/**
 * Classe statique regroupant les données de plusieurs corps célestes.
 */
export class PlanetData {
    public static planets: Record<string, PlanetInfo> = {
        Sun: {
            position: ScaleManager.toSimulationVector(new Vector3(0, 0, 0)),
            diameter: ScaleManager.toSimulationUnits(1_391_000),
            rotationSpeed: 0,
        },
        Mercury: {
            position: ScaleManager.toSimulationVector(
                new Vector3(57_910_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(4_879),
            rotationSpeed: 6.283 / (58.6 * 86400),
        },
        Venus: {
            position: ScaleManager.toSimulationVector(
                new Vector3(108_200_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(12_104),
            rotationSpeed: 6.283 / (243 * 86400),
        },
        Earth: {
            position: ScaleManager.toSimulationVector(
                new Vector3(149_600_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(12_742),
            rotationSpeed: 6.283 / 86400,
        },
        Mars: {
            position: ScaleManager.toSimulationVector(
                new Vector3(227_900_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(6_779),
            rotationSpeed: 6.283 / (1.025 * 86400),
        },
        Jupiter: {
            position: ScaleManager.toSimulationVector(
                new Vector3(778_500_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(139_820),
            rotationSpeed: 6.283 / (0.41 * 86400),
        },
        Saturn: {
            position: ScaleManager.toSimulationVector(
                new Vector3(1_429_000_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(116_460),
            rotationSpeed: 6.283 / (0.45 * 86400),
        },
        Uranus: {
            position: ScaleManager.toSimulationVector(
                new Vector3(2_870_000_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(50_724),
            rotationSpeed: -6.283 / (0.72 * 86400),
        },
        Neptune: {
            position: ScaleManager.toSimulationVector(
                new Vector3(4_500_000_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(49_244),
            rotationSpeed: 6.283 / (0.67 * 86400),
        },
        Pluto: {
            position: ScaleManager.toSimulationVector(
                new Vector3(5_906_400_000, 0, 0)
            ),
            diameter: ScaleManager.toSimulationUnits(2_377),
            rotationSpeed: 6.283 / (6.4 * 86400),
        },
    };

    /**
     * Récupère les données d'une planète à partir de son nom.
     * @param planetName Le nom de la planète (ex. "Mercury", "Earth", etc.).
     * @returns Les informations associées à la planète.
     */
    public static get(planetName: keyof typeof PlanetData.planets): PlanetInfo {
        return PlanetData.planets[planetName];
    }
}
