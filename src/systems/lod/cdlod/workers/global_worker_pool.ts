import { WorkerPool } from "./worker_pool";

/**
 * Global worker pool for terrain mesh computation.
 *
 * The worker script URL is resolved relative to this file to keep the path stable
 * when other modules move during refactors.
 *
 * Workers and concurrency are set using hardwareConcurrency (minus one to keep the UI responsive).
 */
const hc = navigator.hardwareConcurrency ?? 4;
const n = Math.max(1, hc - 1);

export const globalWorkerPool = new WorkerPool(
    () => new Worker(
        new URL("./terrain_mesh_worker.ts", import.meta.url), { type: "module" }),
    n,
    n,
    true
);
