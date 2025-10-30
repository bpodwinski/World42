import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core";

/**
 * Charge dynamiquement ScaleManager avec un SCALE_FACTOR donné.
 * On reset le module cache pour que la valeur statique soit lue à chaque fois.
 */
async function loadScaleManagerWithFactor(factor: number) {
    vi.resetModules();
    process.env.SCALE_FACTOR = String(factor);
    const mod = await import("./scale_manager");

    return mod.ScaleManager;
}

beforeEach(() => {
    vi.resetModules();
});

describe("ScaleManager — conversions scalaires", () => {
    it.each([1, 0.001, 100, 123.456])(
        "km <-> sim roundtrip (SCALE_FACTOR=%s)",
        async (factor) => {
            const ScaleManager = await loadScaleManagerWithFactor(factor);
            const samples = [0, 1, 42.5, 10_000, -7.25];

            for (const km of samples) {
                const sim = ScaleManager.toSimulationUnits(km);
                const back = ScaleManager.toRealUnits(sim);
                expect(sim).toBeCloseTo(km * factor, 12);
                expect(back).toBeCloseTo(km, 12);
            }
        }
    );

    it("km <-> meters helpers", async () => {
        const ScaleManager = await loadScaleManagerWithFactor(1);
        expect(ScaleManager.kmToMeters(1)).toBe(1000);
        expect(ScaleManager.kmToMeters(0.5)).toBe(500);
        expect(ScaleManager.metersToKm(1000)).toBe(1);
        expect(ScaleManager.metersToKm(250)).toBe(0.25);
    });
});

describe("ScaleManager — conversions vecteurs", () => {
    it.each([1, 0.1, 1000])(
        "Vector3 km <-> sim (SCALE_FACTOR=%s)",
        async (factor) => {
            const ScaleManager = await loadScaleManagerWithFactor(factor);

            const vKm = new Vector3(1.2, -3.4, 5.6); // en kilomètres
            const vSim = ScaleManager.toSimulationVector(vKm);
            const vBack = ScaleManager.toRealVector(vSim);

            expect(vSim.x).toBeCloseTo(vKm.x * factor, 12);
            expect(vSim.y).toBeCloseTo(vKm.y * factor, 12);
            expect(vSim.z).toBeCloseTo(vKm.z * factor, 12);

            expect(vBack.x).toBeCloseTo(vKm.x, 12);
            expect(vBack.y).toBeCloseTo(vKm.y, 12);
            expect(vBack.z).toBeCloseTo(vKm.z, 12);

            // Vérifie que `scale()` n’a pas muté l’input (Vector3.scale renvoie une copie)
            expect(vKm.x).toBe(1.2);
            expect(vKm.y).toBe(-3.4);
            expect(vKm.z).toBe(5.6);
        }
    );
});

describe("ScaleManager — vitesses", () => {
    it.each([1, 0.5, 100])(
        "sim/s <-> km/s (SCALE_FACTOR=%s)",
        async (factor) => {
            const ScaleManager = await loadScaleManagerWithFactor(factor);
            const kmps = 7.89; // ex: vitesse orbitale basse Terre (km/s, ordre de grandeur)
            const simps = ScaleManager.kmPerSecToSimSpeed(kmps);
            const backKmps = ScaleManager.simSpeedToKmPerSec(simps);

            expect(simps).toBeCloseTo(kmps * factor, 12);
            expect(backKmps).toBeCloseTo(kmps, 12);
        }
    );

    it.each([1, 0.5, 100])(
        "sim/s <-> m/s (SCALE_FACTOR=%s)",
        async (factor) => {
            const ScaleManager = await loadScaleManagerWithFactor(factor);
            const mps = 1000; // m/s
            const simps = ScaleManager.metersPerSecToSimSpeed(mps);
            const backMps = ScaleManager.simSpeedToMetersPerSec(simps);

            expect(simps).toBeCloseTo((mps / 1000) * factor, 12); // m/s -> km/s -> sim/s
            expect(backMps).toBeCloseTo(mps, 12);
        }
    );
});

describe("ScaleManager — accélérations", () => {
    it.each([1, 2, 50])(
        "sim/s² <-> km/s² (SCALE_FACTOR=%s)",
        async (factor) => {
            const ScaleManager = await loadScaleManagerWithFactor(factor);
            const kmps2 = 0.00981; // ~g en km/s²
            const simps2 = ScaleManager.kmPerSec2ToSimAccel(kmps2);
            const backKmps2 = ScaleManager.simAccelToKmPerSec2(simps2);

            expect(simps2).toBeCloseTo(kmps2 * factor, 12);
            expect(backKmps2).toBeCloseTo(kmps2, 12);
        }
    );

    it.each([1, 2, 50])(
        "sim/s² <-> m/s² (SCALE_FACTOR=%s)",
        async (factor) => {
            const ScaleManager = await loadScaleManagerWithFactor(factor);
            const mps2 = 9.81; // m/s²
            const simps2 = ScaleManager.metersPerSec2ToSimAccel(mps2);
            const backMps2 = ScaleManager.simAccelToMetersPerSec2(simps2);

            // m/s² -> km/s² -> sim/s²
            expect(simps2).toBeCloseTo((mps2 / 1000) * factor, 12);
            // sim/s² -> km/s² -> m/s²
            expect(backMps2).toBeCloseTo(mps2, 12);
        }
    );
});

describe("ScaleManager — cas limites", () => {
    it("SCALE_FACTOR très grand ou très petit", async () => {
        {
            const ScaleManager = await loadScaleManagerWithFactor(1e-9);
            expect(ScaleManager.toSimulationUnits(1)).toBeCloseTo(1e-9, 24);
            expect(ScaleManager.toRealUnits(1e-9)).toBeCloseTo(1, 12);
        }
        {
            const ScaleManager = await loadScaleManagerWithFactor(1e9);
            expect(ScaleManager.toSimulationUnits(2)).toBeCloseTo(2e9, 3);
            expect(ScaleManager.toRealUnits(2e9)).toBeCloseTo(2, 12);
        }
    });

    // Note: SCALE_FACTOR = 0 produirait une division par zéro. On documente plutôt
    // la contrainte dans le code de production, ou on ajoute un guard si nécessaire.
});
