import { PriorityQueue } from "./priorityQueue";

/**
 * Interface for tasks to send to worker
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
 */
interface WorkerWithTask extends Worker {
    /**
     * Currently assigned task for worker
     */
    currentTask?: WorkerTask;
}

/**
 * WorkerPool class manages a pool of workers for general task processing
 */
export class WorkerPool {
    // Workers in different states
    private availableWorkers: Worker[] = [];
    private busyWorkers: Worker[] = [];

    // PriorityQueue for tasks waiting to be executed
    private taskQueue: PriorityQueue<WorkerTask>;

    private maxWorkers: number = navigator.hardwareConcurrency - 1 || 1;
    private maxConcurrentTasks: number;
    private activeTaskCount: number = 0;
    private displayStatus: boolean;
    private workerStatusTimeout: number | null = null;

    /**
     * Creates new WorkerPool instance using provided worker URL, worker count and concurrent task limit
     *
     * @param workerScriptURL - script URL of worker script to use for each worker instance
     * @param maxWorkers - Number of workers to initialize
     * @param maxConcurrentTasks - Maximum number of tasks running concurrently (default equals maxWorkers)
     * @param displayStatus - Enable or disable worker status display
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

        // Initialisation de la PriorityQueue avec un comparateur (ordre croissant de priorité)
        this.taskQueue = new PriorityQueue<WorkerTask>(
            (a, b) => a.priority - b.priority
        );

        // Initialise les workers et les ajoute à la liste des disponibles
        for (let i = 0; i < maxWorkers; i++) {
            const worker = new Worker(workerScriptURL, { type: "module" });
            worker.onmessage = (event: MessageEvent) => {
                this.handleWorkerMessage(worker, event.data);
            };

            worker.onerror = (error) => {
                console.error("[Worker Error]", error);
                this.handleWorkerError(worker);
            };

            this.addWorkerToAvailable(worker);
        }
    }

    /**
     * Enqueues new task to worker pool
     *
     * @param task - Task to enqueue
     */
    enqueueTask(task: WorkerTask) {
        this.taskQueue.push(task);
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    /**
     * Schedules next task from queue if available and concurrency limit not exceeded
     *
     * @private
     */
    private scheduleNext() {
        // Respecte la limite de concurrence
        if (this.activeTaskCount >= this.maxConcurrentTasks) {
            this.updateWorkerStatus();
            return;
        }

        if (this.taskQueue.size() === 0) return;

        // S'assure qu'un worker est disponible
        if (this.availableWorkers.length === 0) {
            this.updateWorkerStatus();
            return;
        }

        // Extrait la tâche de plus haute priorité
        const task = this.taskQueue.pop()!;
        // Prend un worker depuis availableWorkers
        const worker = this.availableWorkers.shift()!;
        (worker as WorkerWithTask).currentTask = task;
        this.markWorkerBusy(worker);

        // Incrémente le compteur de tâches actives et envoie la tâche
        this.activeTaskCount++;
        worker.postMessage(task.data);
        this.updateWorkerStatus();
    }

    /**
     * Handles a message from a worker
     *
     * @param worker - Worker that sent the message
     * @param data - Data returned by the worker
     * @private
     */
    private handleWorkerMessage(worker: Worker, data: any) {
        this.markWorkerAvailable(worker);
        this.activeTaskCount--; // Tâche terminée

        const workerWithTask = worker as WorkerWithTask;
        if (workerWithTask.currentTask) {
            workerWithTask.currentTask.callback(data);
            delete workerWithTask.currentTask;
        }
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    /**
     * Handles an error from a worker
     *
     * @param worker - Worker that encountered an error
     * @private
     */
    private handleWorkerError(worker: Worker) {
        this.markWorkerAvailable(worker);
        this.activeTaskCount--; // En cas d'erreur, décrémente le compteur de tâches actives
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    /**
     * Marks a worker as busy by moving it from availableWorkers to busyWorkers
     *
     * @param worker - Worker to mark as busy
     * @private
     */
    private markWorkerBusy(worker: Worker) {
        this.removeWorkerFromArray(worker, this.availableWorkers);
        if (!this.busyWorkers.includes(worker)) {
            this.busyWorkers.push(worker);
        }
    }

    /**
     * Marks a worker as available by moving it from busyWorkers to availableWorkers
     *
     * @param worker - Worker to mark as available
     * @private
     */
    private markWorkerAvailable(worker: Worker) {
        this.removeWorkerFromArray(worker, this.busyWorkers);
        if (!this.availableWorkers.includes(worker)) {
            this.availableWorkers.push(worker);
        }
    }

    /**
     * Adds a worker to availableWorkers array
     *
     * @param worker - Worker to add
     * @private
     */
    private addWorkerToAvailable(worker: Worker) {
        if (!this.availableWorkers.includes(worker)) {
            this.availableWorkers.push(worker);
        }
    }

    /**
     * Removes a worker from a specified array
     *
     * @param worker - Worker to remove
     * @param arr - Array from which to remove the worker
     * @private
     */
    private removeWorkerFromArray(worker: Worker, arr: Worker[]) {
        const index = arr.indexOf(worker);
        if (index !== -1) {
            arr.splice(index, 1);
        }
    }

    /**
     * Updates worker status display using element with id "worker-status" if displayStatus is enabled
     *
     * @private
     */
    private updateWorkerStatus() {
        if (!this.displayStatus) return;
        if (this.workerStatusTimeout !== null) return;

        this.workerStatusTimeout = window.setTimeout(() => {
            const availableCount = this.availableWorkers.length;
            const busyCount = this.busyWorkers.length;
            const pendingTasks = this.taskQueue.size();
            const info = `Workers: Available: ${availableCount} | Busy: ${busyCount} | Tasks pending: ${pendingTasks}`;
            const statusDiv = document.getElementById("worker-status");
            if (statusDiv) {
                statusDiv.innerText = info;
            }
            this.workerStatusTimeout = null;
        }, 250);
    }

    /**
     * Terminates all workers and clears worker pool
     */
    terminate() {
        [...this.availableWorkers, ...this.busyWorkers].forEach((w) =>
            w.terminate()
        );
        this.availableWorkers = [];
        this.busyWorkers = [];
        // Réinitialise la PriorityQueue en créant une nouvelle instance
        this.taskQueue = new PriorityQueue<WorkerTask>(
            (a, b) => a.priority - b.priority
        );
        this.activeTaskCount = 0;
        this.updateWorkerStatus();
    }
}
