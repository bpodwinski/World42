/**
 * Lazily-created singleton Web Worker that runs the off-thread CBT kernels.
 * STATEFUL: owns every planet's tree, so there is exactly one instance
 * (round-robin happens inside via the per-frame message stream).
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
