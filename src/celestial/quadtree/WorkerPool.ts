/**
 * Interface for tasks to send to worker
 *
 * @interface
 */
export interface WorkerTask {
    /**
     * Data to send to worker
     */
    data: any;

    /**
     * Priority of task (e.g. distance to camera; lower value means higher priority)
     */
    priority: number;

    /**
     * Callback to process result returned by worker
     */
    callback: (result: any) => void;
}

/**
 * Extended Worker interface with currentTask property
 *
 * @interface
 */
interface WorkerWithTask extends Worker {
    /**
     * Currently assigned task for worker
     */
    currentTask?: WorkerTask;
}

/**
 * WorkerPool class manages a pool of workers for general task processing
 *
 * @class
 */
export class WorkerPool {
    private workers: Worker[] = [];
    private maxWorkers: number = navigator.hardwareConcurrency || 1;
    private busyWorkers: Set<Worker> = new Set();
    private workerStatusTimeout: number | null = null;
    private taskQueue: WorkerTask[] = [];

    // Limit concurrent tasks
    private maxConcurrentTasks: number;

    // Count active tasks
    private activeTaskCount: number = 0;

    // Flag to control display of worker status
    private displayStatus: boolean;

    /**
     * Creates new WorkerPool instance using provided worker URL, worker count and concurrent task limit
     *
     * @param {string} workerScriptURL - scriptURL of worker script to use for each worker instance
     * @param {number} maxWorkers - Number of workers to initialize
     * @param {number} maxConcurrentTasks - Maximum number of tasks running concurrently (default equals maxWorkers)
     * @param {boolean} [displayStatus=false] - Enable or disable worker status display
     */
    constructor(
        workerScriptURL: string,
        maxWorkers: number,
        maxConcurrentTasks: number = maxWorkers,
        displayStatus: boolean = false
    ) {
        this.maxWorkers = maxWorkers;
        this.maxConcurrentTasks = maxConcurrentTasks;
        this.displayStatus = displayStatus;

        for (let i = 0; i < maxWorkers; i++) {
            //const worker = createWorker(workerScriptURL);
            const worker = new Worker(workerScriptURL, { type: "module" });

            worker.onmessage = (event: MessageEvent) => {
                this.busyWorkers.delete(worker);
                this.activeTaskCount--; // Task finished

                if ((worker as WorkerWithTask).currentTask) {
                    const callback = (worker as WorkerWithTask).currentTask!
                        .callback;
                    callback(event.data);
                    delete (worker as WorkerWithTask).currentTask;
                }

                this.updateWorkerStatus();
                this.scheduleNext();
            };

            worker.onerror = (error) => {
                console.error("[Worker Error]", error);
                this.busyWorkers.delete(worker);
                this.activeTaskCount--; // On error, decrement active tasks count
                this.updateWorkerStatus();
                this.scheduleNext();
            };

            this.workers.push(worker);
        }
    }

    /**
     * Enqueues new task to worker pool
     *
     * @param {WorkerTask} task - Task to enqueue
     */
    enqueueTask(task: WorkerTask) {
        this.taskQueue.push(task);
        this.taskQueue.sort((a, b) => a.priority - b.priority);
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    /**
     * Schedules next task from queue if available and concurrency limit not exceeded
     *
     * @private
     */
    private scheduleNext() {
        // Check if active tasks exceed concurrency limit
        if (this.activeTaskCount >= this.maxConcurrentTasks) {
            this.updateWorkerStatus();
            return;
        }

        if (this.taskQueue.length === 0) return;

        // Find free worker
        const availableWorker = this.workers.find(
            (w) => !this.busyWorkers.has(w)
        );

        if (!availableWorker) {
            this.updateWorkerStatus();
            return; // All workers busy
        }

        // Dequeue highest priority task
        const task = this.taskQueue.shift()!;
        (availableWorker as WorkerWithTask).currentTask = task;

        this.busyWorkers.add(availableWorker);
        this.activeTaskCount++; // Increment active tasks count

        availableWorker.postMessage(task.data);
        this.updateWorkerStatus();
    }

    /**
     * Updates worker status display using element with id "worker-status" if displayStatus is enabled
     *
     * @private
     */
    private updateWorkerStatus() {
        if (!this.displayStatus) {
            return;
        }

        if (this.workerStatusTimeout !== null) {
            return;
        }

        this.workerStatusTimeout = window.setTimeout(() => {
            const busyCount = this.busyWorkers.size;
            const total = this.workers.length;
            const pendingTasks = this.taskQueue.length;
            const info = `Workers busy: ${busyCount} / ${total}, Active tasks: ${this.activeTaskCount}, Tasks pending: ${pendingTasks}`;
            const statusDiv = document.getElementById("worker-status");

            if (statusDiv) {
                statusDiv.innerText = info;
            }

            this.workerStatusTimeout = null;
        }, 500);
    }

    /**
     * Terminates all workers and clears worker pool
     */
    terminate() {
        this.workers.forEach((w) => w.terminate());
        this.workers = [];
        this.taskQueue = [];
        this.busyWorkers.clear();
        this.activeTaskCount = 0;
        this.updateWorkerStatus();
    }
}
