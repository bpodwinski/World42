import type { LoadedSystem } from './stellar_catalog_loader';

/**
 * Benchmark mode (dev-only): triggered by `?bench=1` (or any non-empty `?bench=`
 * value). When active, loads ONLY the dedicated {@link BENCH_SYSTEM_ID} system and
 * freezes its planet rotation so the surface stays still under the camera.
 *
 * Pairs with scripts/terrain_perf_capture.mjs / terrain_perf_matrix.mjs.
 */

/** Dedicated benchmark system id (see data.json). */
export const BENCH_SYSTEM_ID = 'Benchmark';

/** Returns true when `?bench=` is present and non-empty in the search string. */
export function parseBenchAlgorithm(search: string): boolean {
    if (!search) return false;
    const params = new URLSearchParams(search);
    const raw = params.get('bench');
    return raw !== null && raw.length > 0;
}

/**
 * Parse `?system=<id>` — load ONLY that system (case-insensitive match against the catalog ids).
 * Lets you isolate e.g. the Dev system without loading all 16 planets. Null if absent.
 */
export function parseSystemFilter(search: string): string | null {
    if (!search) return null;
    const raw = new URLSearchParams(search).get('system');
    return raw && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Parse `?planet=<name>` — spawn the camera at this planet (case-insensitive name match). Null if
 * absent. Pairs well with `?system=` (e.g. `?system=Dev&planet=Earth`).
 */
export function parsePlanetName(search: string): string | null {
    if (!search) return null;
    const raw = new URLSearchParams(search).get('planet');
    return raw && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Choose which systems to load. Precedence: bench mode (Benchmark only) > `?system=<id>` filter >
 * everything. An unknown `?system=` value falls back to loading all systems.
 */
export function selectSystemIds(
    allIds: string[],
    benchActive: boolean,
    systemFilter: string | null
): string[] {
    if (benchActive) {
        return allIds.includes(BENCH_SYSTEM_ID) ? [BENCH_SYSTEM_ID] : allIds;
    }
    if (systemFilter) {
        const match = allIds.find((id) => id.toLowerCase() === systemFilter.toLowerCase());
        if (match) return [match];
    }
    return allIds;
}

/**
 * FREEZES every non-star body rotation (`rotationPeriodDays = null`) so the
 * surface stays still under the camera during a benchmark run. No-op when inactive.
 */
export function applyBenchOverride(
    loadedSystems: Map<string, LoadedSystem>,
    active: boolean
): void {
    if (!active) return;
    for (const system of loadedSystems.values()) {
        for (const body of system.bodies.values()) {
            if (body.bodyType !== 'star') {
                body.rotationPeriodDays = null;
            }
        }
    }
}
