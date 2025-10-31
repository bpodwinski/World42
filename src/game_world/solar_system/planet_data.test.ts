import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("./data.json", () => ({
    default: {
        Earth: {
            position_km: [1, 2, 3],
            diameter_km: 12742,
            rotation_period_days: 1,
        },
        Mars: {
            position_km: [-10, 0, 10],
            diameter_km: 6779,
            rotation_period_days: 1.02595675, // real-ish value
        },
        ZeroSpin: {
            position_km: [0, 0, 0],
            diameter_km: 1,
            rotation_period_days: 0,
        },
        NullSpin: {
            position_km: [0, 0, 0],
            diameter_km: 1,
            rotation_period_days: null,
        },
    },
}));

// We mock the ScaleManager so we don't depend on project scale config.
// Use a clear factor so we can assert exact numbers.
vi.mock("../../core/scale/scale_manager", async (orig) => {
    const { Vector3 } = await import("@babylonjs/core");
    const FACTOR = 1000; // 1 km = 1000 sim units (example)
    return {
        ScaleManager: {
            toSimulationUnits: (km: number) => km * FACTOR,
            toSimulationVector: (v: InstanceType<typeof Vector3>) =>
                new Vector3(v.x * FACTOR, v.y * FACTOR, v.z * FACTOR),
        },
    };
});

// Silence console noise from PlanetData static initializer during tests
const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => { });

import { PlanetData } from "./planet_data";
import { Vector3 } from "@babylonjs/core";

const TWO_PI = 2 * Math.PI;
const SECONDS_PER_DAY = 86400;

describe("PlanetData", () => {
    it("expose every mocked body via .get()", () => {
        expect(PlanetData.get("Earth")).toBeDefined();
        expect(PlanetData.get("Mars")).toBeDefined();
        expect(PlanetData.get("ZeroSpin")).toBeDefined();
        expect(PlanetData.get("NullSpin")).toBeDefined();
    });

    it("converts position_km -> simulation units via ScaleManager.toSimulationVector", () => {
        const earth = PlanetData.get("Earth");
        // Expect factor x1000 from mock
        expect(earth.position.equals(new Vector3(1000, 2000, 3000))).toBe(true);

        const mars = PlanetData.get("Mars");
        expect(mars.position.equals(new Vector3(-10000, 0, 10000))).toBe(true);
    });

    it("converts diameter_km -> simulation units via ScaleManager.toSimulationUnits", () => {
        const earth = PlanetData.get("Earth");
        // 12742 km -> 12_742_000 sim units
        expect(earth.diameter).toBe(12_742_000);

        const mars = PlanetData.get("Mars");
        expect(mars.diameter).toBe(6_779_000);
    });

    it("computes rotationSpeed in rad/s = 2π / (days * 86400)", () => {
        const earth = PlanetData.get("Earth");
        const expected = TWO_PI / (1 * SECONDS_PER_DAY);
        expect(earth.rotationSpeed).toBeCloseTo(expected, 12);

        const mars = PlanetData.get("Mars");
        const expectedMars = TWO_PI / (1.02595675 * SECONDS_PER_DAY);
        expect(mars.rotationSpeed).toBeCloseTo(expectedMars, 12);
    });

    it("handles rotation_period_days of 0 or null as 0 rad/s", () => {
        const zero = PlanetData.get("ZeroSpin");
        const nul = PlanetData.get("NullSpin");
        expect(zero.rotationSpeed).toBe(0);
        expect(nul.rotationSpeed).toBe(0);
    });
});
