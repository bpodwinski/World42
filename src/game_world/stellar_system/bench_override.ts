import type { LoadedSystem } from './stellar_catalog_loader';

/**
 * Benchmark mode (dev-only): triggered by `?bench=1` (or any non-empty `?bench=`
 * value). When active, loads ONLY the dedicated {@link BENCH_SYSTEM_ID} system and
 * freezes its planet rotation so the surface stays still under the camera.
 *
 * Pairs with scripts/cbt_perf_capture.mjs / cbt_perf_matrix.mjs.
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
 * Filter a freshly built system-id list down to the benchmark system when bench
 * mode is active. Returns the input unchanged when inactive.
 */
export function benchSystemIds(allIds: string[], active: boolean): string[] {
    if (!active) return allIds;
    return allIds.includes(BENCH_SYSTEM_ID) ? [BENCH_SYSTEM_ID] : allIds;
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
