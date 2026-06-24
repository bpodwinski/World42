import type { LoadedSystem, LodAlgorithm } from './stellar_catalog_loader';

/**
 * Benchmark mode (dev-only): drives the perf harness so the SAME planet can be
 * rendered with each LOD backend in turn.
 *
 * Triggered by the `?bench=<algo>` URL query param. When present, the bootstrap
 * loads ONLY the dedicated {@link BENCH_SYSTEM_ID} system (isolating the cost
 * from every other planet/scheduler) and forces its planet(s) onto `<algo>`.
 * When absent, the normal catalog loads unchanged (zero production impact).
 *
 * Pairs with scripts/cbt_perf_capture.mjs / cbt_perf_matrix.mjs.
 */

/** Dedicated benchmark system id (see data.json). */
export const BENCH_SYSTEM_ID = 'Benchmark';

const VALID: readonly LodAlgorithm[] = ['cdlod', 'cbt-cpu', 'cbt-gpu', 'cbt-ocbt'];

/**
 * Parse `?bench=<algo>` from a `location.search` string.
 * @returns the requested LOD algorithm, or null if absent/invalid.
 */
export function parseBenchAlgorithm(search: string): LodAlgorithm | null {
    if (!search) return null;
    const params = new URLSearchParams(search);
    const raw = params.get('bench');
    if (!raw) return null;
    const v = raw.toLowerCase().trim() as LodAlgorithm;
    return VALID.includes(v) ? v : null;
}

/**
 * Filter a freshly built system-id list down to the benchmark system when bench
 * mode is active. Returns the input unchanged when `algo` is null, or the bench
 * id alone when it is present (and known).
 */
export function benchSystemIds(allIds: string[], algo: LodAlgorithm | null): string[] {
    if (!algo) return allIds;
    return allIds.includes(BENCH_SYSTEM_ID) ? [BENCH_SYSTEM_ID] : allIds;
}

/**
 * Force every non-star body of the loaded systems onto `algo` (in place). Stars
 * keep their type. No-op when `algo` is null.
 */
export function applyBenchOverride(
    loadedSystems: Map<string, LoadedSystem>,
    algo: LodAlgorithm | null
): void {
    if (!algo) return;
    for (const system of loadedSystems.values()) {
        for (const body of system.bodies.values()) {
            if (body.bodyType !== 'star') {
                body.lodAlgorithm = algo;
            }
        }
    }
}
