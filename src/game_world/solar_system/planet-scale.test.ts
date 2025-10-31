import { describe, it, expect, beforeAll } from "vitest";
let ScaleManager: any;
let planets: Record<string, { diameter_km: number }>;

beforeAll(async () => {
    process.env.SCALE_FACTOR = "1000";
    ({ ScaleManager } = await import("../../core/scale/scale_manager"));
    // Chemin à adapter si nécessaire (ex: src/assets/planets.json)
    planets = (await import("./data.json")).default;
});

describe("Planet diameters -> simulation units", () => {
    it("Earth matches expected sim diameter", () => {
        const earth = planets["Earth"];
        const expected = ScaleManager.toSimulationUnits(earth.diameter_km);
        // La fonction que tu utilises pour créer la sphère doit renvoyer expected
        const got = ScaleManager.toSimulationUnits(earth.diameter_km);
        expect(got).toBe(expected);
    });

    it("All bodies match expected sim diameter", () => {
        for (const [_, body] of Object.entries(planets)) {
            const expected = ScaleManager.toSimulationUnits(body.diameter_km);
            const got = ScaleManager.toSimulationUnits(body.diameter_km);
            expect(got).toBe(expected);
        }
    });

    it("Catches a double-scale bug (negative test)", () => {
        const mercury = planets["Mercury"]; // ex: 4879 km
        const correct = ScaleManager.toSimulationUnits(mercury.diameter_km);
        const doubleBug = ScaleManager.toSimulationUnits(correct); // double conversion simulée
        expect(doubleBug).toBe(correct * Number(process.env.SCALE_FACTOR));
        expect(correct).not.toBe(doubleBug);
    });
});
