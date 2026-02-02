import { PriorityQueue } from "./priority_queue";
import type { MeshKernelResponse, MeshKernelRequest } from "./worker_protocol";

/**
 * A unit of work scheduled for a {@link WorkerPool}.
 */
export interface WorkerTask {
    /** Outgoing request sent to the worker (mesh-kernel/1 protocol). */
    data: MeshKernelRequest;

    /**
     * Lower values run first (min-heap).
     * Example: distance-based priority (closer chunks => smaller number).
     */
    priority: number;

    /**
     * Called when the worker returns a successful result.
     * @param result Mesh data returned by the worker.
     * @param stats Optional worker stats.
     */
    callback: (result: any, stats?: any) => void;

    /**
     * Called when the worker returns a protocol error, runtime error, or crashes.
     * @param err Error payload or internal error descriptor.
     */
    onError?: (err: any) => void;
}

/**
 * Extends the standard Worker with per-task bookkeeping used by the pool.
 */
interface WorkerWithTask extends Worker {
    /** Currently running task on this worker (if any). */
    currentTask?: WorkerTask;

    /** True once the worker has responded with "ready". */
    isReady?: boolean;
}

/**
 * A simple worker pool with:
 * - strict mesh-kernel/1 protocol enforcement
 * - a priority queue scheduler
 * - a handshake step ("init" => "ready") before using workers
 */
export class WorkerPool {
    private availableWorkers: WorkerWithTask[] = [];
    private busyWorkers: WorkerWithTask[] = [];
    private taskQueue: PriorityQueue<WorkerTask>;

    /** Total number of workers created by this pool. */
    private readonly maxWorkers: number;

    /** Max number of tasks allowed in-flight concurrently. */
    private readonly maxConcurrentTasks: number;

    /** Number of tasks currently in-flight across all workers. */
    private activeTaskCount = 0;

    /** Whether to display status info in a DOM element. */
    private readonly displayStatus: boolean;

    /** Debounce handle used by {@link updateWorkerStatus}. */
    private workerStatusTimeout: number | null = null;

    /**
     * Creates a new worker pool.
     * @param createWorker Factory that returns a new Worker instance.
     * @param maxWorkers Number of workers to spawn.
     * @param maxConcurrentTasks Max number of tasks running in parallel (defaults to maxWorkers).
     * @param displayStatus If true, updates a #worker-status element periodically.
     */
    constructor(
        createWorker: () => Worker,
        maxWorkers: number,
        maxConcurrentTasks: number = maxWorkers,
        displayStatus: boolean = false
    ) {
        this.maxWorkers = Math.max(1, maxWorkers);
        this.maxConcurrentTasks = Math.max(1, maxConcurrentTasks);
        this.displayStatus = displayStatus;

        this.taskQueue = new PriorityQueue<WorkerTask>((a, b) => a.priority - b.priority);

        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = createWorker() as WorkerWithTask;
            worker.isReady = false;

            worker.onmessage = (event: MessageEvent) => {
                this.handleWorkerMessage(worker, event.data);
            };

            worker.onerror = (error) => {
                console.error("[Worker Error]", error);
                this.handleWorkerError(worker);
            };

            // Handshake init
            const initMsg: MeshKernelRequest = {
                protocol: "mesh-kernel/1",
                kind: "init",
                id: `init-${i}`,
                payload: {},
            };

            worker.postMessage(initMsg);

            // Not available until we receive "ready"
            this.busyWorkers.push(worker);
        }
    }

    /**
     * Enqueues a task to be processed by the pool.
     * @param task The task to enqueue.
     */
    enqueueTask(task: WorkerTask) {
        this.taskQueue.push(task);
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    /**
     * Attempts to schedule the next task if capacity and workers are available.
     */
    private scheduleNext() {
        if (this.activeTaskCount >= this.maxConcurrentTasks) {
            this.updateWorkerStatus();
            return;
        }
        if (this.taskQueue.size() === 0) return;

        // Only "ready" workers are available
        if (this.availableWorkers.length === 0) {
            this.updateWorkerStatus();
            return;
        }

        const task = this.taskQueue.pop()!;
        const worker = this.availableWorkers.shift()!;

        worker.currentTask = task;
        this.markWorkerBusy(worker);

        this.activeTaskCount++;
        worker.postMessage(task.data);
        this.updateWorkerStatus();
    }

    /**
     * Handles a message coming from a worker. Strict mesh-kernel/1 only.
     * Any non-protocol message is treated as an error (no legacy fallback).
     * @param worker The worker that sent the message.
     * @param data The raw message payload.
     */
    private handleWorkerMessage(worker: WorkerWithTask, data: any) {
        // Reject anything not matching the protocol shape
        if (!data || typeof data !== "object" || data.protocol !== "mesh-kernel/1") {
            const task = worker.currentTask;
            delete worker.currentTask;

            this.markWorkerAvailable(worker);
            if (task) this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);

            const err = { code: "protocol_error", message: "Non-protocol worker message", data };
            if (task?.onError) task.onError(err);
            else console.error("[WorkerPool]", err);

            this.updateWorkerStatus();
            this.scheduleNext();
            return;
        }

        const msg = data as MeshKernelResponse;

        // Handshake
        if (msg.kind === "ready") {
            worker.isReady = true;
            this.markWorkerAvailable(worker);
            this.updateWorkerStatus();
            this.scheduleNext();
            return;
        }

        // Any other message must correspond to an in-flight task
        const task = worker.currentTask;
        delete worker.currentTask;

        this.markWorkerAvailable(worker);
        if (task) this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);

        if (!task) {
            console.warn("[WorkerPool] Protocol message without currentTask:", msg);
            this.updateWorkerStatus();
            this.scheduleNext();
            return;
        }

        if (msg.kind === "chunk_result") {
            task.callback(msg.payload.meshData, msg.payload.stats);
        } else if (msg.kind === "error") {
            if (task.onError) task.onError(msg.payload);
            else console.error("[Worker Task Error]", msg.payload);
        } else {
            const err = { code: "unexpected_kind", message: `Unexpected kind: ${String((msg as any).kind)}`, msg };
            if (task.onError) task.onError(err);
            else console.error("[WorkerPool]", err);
        }

        this.updateWorkerStatus();
        this.scheduleNext();
    }

    /**
     * Handles a worker crash/error event.
     * @param worker The worker that errored.
     */
    private handleWorkerError(worker: WorkerWithTask) {
        const task = worker.currentTask;
        delete worker.currentTask;

        this.markWorkerAvailable(worker);
        if (task) this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);

        if (task?.onError) {
            task.onError({ code: "worker_error", message: "Worker crashed" });
        } else {
            console.error("[WorkerPool] Worker crashed without an active task");
        }

        this.updateWorkerStatus();
        this.scheduleNext();
    }

    /**
     * Moves a worker into the busy list.
     * @param worker Worker to mark busy.
     */
    private markWorkerBusy(worker: WorkerWithTask) {
        this.removeWorkerFromArray(worker, this.availableWorkers);
        if (!this.busyWorkers.includes(worker)) this.busyWorkers.push(worker);
    }

    /**
     * Moves a worker into the available list only if it has completed the handshake.
     * @param worker Worker to mark available.
     */
    private markWorkerAvailable(worker: WorkerWithTask) {
        this.removeWorkerFromArray(worker, this.busyWorkers);
        if (worker.isReady && !this.availableWorkers.includes(worker)) {
            this.availableWorkers.push(worker);
        }
    }

    /**
     * Removes a worker from an array if present.
     * @param worker Worker instance.
     * @param arr Target array.
     */
    private removeWorkerFromArray(worker: WorkerWithTask, arr: WorkerWithTask[]) {
        const index = arr.indexOf(worker);
        if (index !== -1) arr.splice(index, 1);
    }

    /**
     * Updates a DOM status element (if enabled) with pool metrics.
     */
    private updateWorkerStatus() {
        if (!this.displayStatus) return;
        if (this.workerStatusTimeout !== null) return;

        this.workerStatusTimeout = window.setTimeout(() => {
            const availableCount = this.availableWorkers.length;
            const busyCount = this.busyWorkers.length;
            const pendingTasks = this.taskQueue.size();

            const info =
                `Workers: ${availableCount} available | ${busyCount} busy | ` +
                `${this.maxWorkers} total | ` +
                `In-flight: ${this.activeTaskCount}/${this.maxConcurrentTasks} | ` +
                `Pending: ${pendingTasks}`;

            const statusDiv = document.getElementById("worker-status");
            if (statusDiv) statusDiv.innerText = info;

            this.workerStatusTimeout = null;
        }, 250);
    }
}
