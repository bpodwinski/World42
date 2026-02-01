import { PriorityQueue } from "./priority_queue";
import type { MeshKernelResponse, MeshKernelRequest } from "./worker-protocol";

export interface WorkerTask {
    data: any; // MeshKernelRequest (ou legacy)
    priority: number;
    callback: (result: any, stats?: any) => void;
    onError?: (err: any) => void;
}

interface WorkerWithTask extends Worker {
    currentTask?: WorkerTask;
    isReady?: boolean;
}

export class WorkerPool {
    private availableWorkers: Worker[] = [];
    private busyWorkers: Worker[] = [];
    private taskQueue: PriorityQueue<WorkerTask>;

    private maxWorkers: number = navigator.hardwareConcurrency - 1 || 1;
    private maxConcurrentTasks: number;
    private activeTaskCount: number = 0;
    private displayStatus: boolean;
    private workerStatusTimeout: number | null = null;

    constructor(
        createWorker: () => Worker,
        maxWorkers: number,
        maxConcurrentTasks: number = maxWorkers,
        displayStatus: boolean = false
    ) {
        this.maxWorkers = maxWorkers;
        this.maxConcurrentTasks = maxConcurrentTasks;
        this.displayStatus = displayStatus;

        this.taskQueue = new PriorityQueue<WorkerTask>((a, b) => a.priority - b.priority);

        for (let i = 0; i < maxWorkers; i++) {
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
            // On ne met pas encore le worker en available tant qu'il n'a pas répondu "ready"
            this.busyWorkers.push(worker);
        }
    }

    enqueueTask(task: WorkerTask) {
        this.taskQueue.push(task);
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    private scheduleNext() {
        if (this.activeTaskCount >= this.maxConcurrentTasks) {
            this.updateWorkerStatus();
            return;
        }
        if (this.taskQueue.size() === 0) return;

        // uniquement les workers prêts
        if (this.availableWorkers.length === 0) {
            this.updateWorkerStatus();
            return;
        }

        const task = this.taskQueue.pop()!;
        const worker = this.availableWorkers.shift()! as WorkerWithTask;

        worker.currentTask = task;
        this.markWorkerBusy(worker);

        this.activeTaskCount++;
        worker.postMessage(task.data);
        this.updateWorkerStatus();
    }

    private handleWorkerMessage(worker: WorkerWithTask, data: any) {
        // Réponses protocole mesh-kernel
        if (data && typeof data === "object" && data.protocol === "mesh-kernel/1") {
            const msg = data as MeshKernelResponse;

            if (msg.kind === "ready") {
                worker.isReady = true;
                // sortir des busy (init) → available
                this.markWorkerAvailable(worker);
                this.updateWorkerStatus();
                this.scheduleNext();
                return;
            }

            // chunk_result / error : libère le worker + termine la tâche
            this.markWorkerAvailable(worker);
            this.activeTaskCount--;

            const task = worker.currentTask;
            delete worker.currentTask;

            if (!task) {
                this.updateWorkerStatus();
                this.scheduleNext();
                return;
            }

            if (msg.kind === "chunk_result") {
                task.callback(msg.payload.meshData, msg.payload.stats);
            } else if (msg.kind === "error") {
                if (task.onError) task.onError(msg.payload);
                else console.error("[Worker Task Error]", msg.payload);
                this.updateWorkerStatus();
                this.scheduleNext();

                return;
            }

            this.updateWorkerStatus();
            this.scheduleNext();

            return;
        }

        // Legacy (ancien worker qui renvoie directement meshData)
        this.markWorkerAvailable(worker);
        this.activeTaskCount--;

        const task = worker.currentTask;
        delete worker.currentTask;
        if (task) task.callback(data, undefined);

        this.updateWorkerStatus();
        this.scheduleNext();
    }

    private handleWorkerError(worker: WorkerWithTask) {
        const task = worker.currentTask;
        delete worker.currentTask;

        this.markWorkerAvailable(worker);
        this.activeTaskCount--;

        if (task?.onError) task.onError({ code: "worker_error", message: "Worker crashed" });

        this.updateWorkerStatus();
        this.scheduleNext();
    }

    private markWorkerBusy(worker: Worker) {
        this.removeWorkerFromArray(worker, this.availableWorkers);
        if (!this.busyWorkers.includes(worker)) this.busyWorkers.push(worker);
    }

    private markWorkerAvailable(worker: WorkerWithTask) {
        this.removeWorkerFromArray(worker, this.busyWorkers);
        // ne rendre available que si prêt
        if (worker.isReady && !this.availableWorkers.includes(worker)) {
            this.availableWorkers.push(worker);
        }
    }

    private removeWorkerFromArray(worker: Worker, arr: Worker[]) {
        const index = arr.indexOf(worker);
        if (index !== -1) arr.splice(index, 1);
    }

    private updateWorkerStatus() {
        if (!this.displayStatus) return;
        if (this.workerStatusTimeout !== null) return;

        this.workerStatusTimeout = window.setTimeout(() => {
            const availableCount = this.availableWorkers.length;
            const busyCount = this.busyWorkers.length;
            const pendingTasks = this.taskQueue.size();
            const info = `Workers: Available: ${availableCount} | Busy: ${busyCount} | Tasks pending: ${pendingTasks}`;
            const statusDiv = document.getElementById("worker-status");
            if (statusDiv) statusDiv.innerText = info;
            this.workerStatusTimeout = null;
        }, 250);
    }
}
