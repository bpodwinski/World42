/**
 * Lazily-created singleton Web Worker that runs the off-thread CBT kernels.
 * Separate from the CDLOD `globalWorkerPool` — the CBT worker is STATEFUL (it owns
 * every planet's tree), so there is exactly one of it (round-robin happens inside,
 * via the per-frame message stream). Rspack bundles the worker from this URL.
 */
let worker: Worker | null = null;

export function getGlobalCbtWorker(): Worker {
    if (!worker) {
        worker = new Worker(
            new URL('./cbt_terrain_worker.ts', import.meta.url),
            { type: 'module' }
        );
    }
    return worker;
}
