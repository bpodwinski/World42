import { createWorker } from "../../workers/workerManager";

export interface WorkerTask {
    data: any; // données à envoyer au Worker
    priority: number; // par exemple, distance à la caméra (plus faible = plus prioritaire)
    callback: (result: any) => void;
}

interface WorkerWithTask extends Worker {
    currentTask?: WorkerTask;
}

export class WorkerPool {
    private workers: Worker[] = [];
    private maxWorkers: number = navigator.hardwareConcurrency || 1;
    private taskQueue: WorkerTask[] = [];
    private busyWorkers: Set<Worker> = new Set();
    private workerStatusTimeout: number | null = null;

    // Limite de concurrence pour les chunks
    private maxConcurrentTasks: number;
    // Nombre de tâches actuellement en cours
    private activeTaskCount: number = 0;

    constructor(maxWorkers: number, maxConcurrentTasks: number = maxWorkers) {
        this.maxWorkers = maxWorkers;
        this.maxConcurrentTasks = maxConcurrentTasks;
        for (let i = 0; i < maxWorkers; i++) {
            const meshChunkWorkerURL = new URL(
                "../../workers/meshChunkWorker",
                import.meta.url
            ).href;
            const worker = createWorker(meshChunkWorkerURL);

            worker.onmessage = (event: MessageEvent) => {
                this.busyWorkers.delete(worker);
                this.activeTaskCount--; // Une tâche vient de se terminer
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
                this.activeTaskCount--; // En cas d'erreur, on décrémente aussi
                this.updateWorkerStatus();
                this.scheduleNext();
            };

            this.workers.push(worker);
        }
    }

    enqueueTask(task: WorkerTask) {
        this.taskQueue.push(task);
        this.taskQueue.sort((a, b) => a.priority - b.priority);
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    private scheduleNext() {
        // Vérifier d'abord qu'on ne dépasse pas la limite de tâches simultanées
        if (this.activeTaskCount >= this.maxConcurrentTasks) {
            this.updateWorkerStatus();
            return;
        }

        if (this.taskQueue.length === 0) return;

        // Trouver un worker libre
        const availableWorker = this.workers.find(
            (w) => !this.busyWorkers.has(w)
        );
        if (!availableWorker) {
            this.updateWorkerStatus();
            return; // Tous les workers sont occupés
        }

        // Dépiler la tâche la plus prioritaire
        const task = this.taskQueue.shift()!;
        (availableWorker as WorkerWithTask).currentTask = task;
        this.busyWorkers.add(availableWorker);
        this.activeTaskCount++; // Incrémenter le compteur de tâches actives

        availableWorker.postMessage(task.data);
        this.updateWorkerStatus();
    }

    private updateWorkerStatus() {
        if (this.workerStatusTimeout !== null) {
            return;
        }
        this.workerStatusTimeout = window.setTimeout(() => {
            const busyCount = this.busyWorkers.size;
            const total = this.workers.length;
            const pendingTasks = this.taskQueue.length;
            const info = `Workers busy: ${busyCount} / ${total}, Active tasks: ${this.activeTaskCount}, Chunks pending: ${pendingTasks}`;
            const statusDiv = document.getElementById("worker-status");
            if (statusDiv) {
                statusDiv.innerText = info;
            }
            this.workerStatusTimeout = null;
        }, 500);
    }

    terminate() {
        this.workers.forEach((w) => w.terminate());
        this.workers = [];
        this.taskQueue = [];
        this.busyWorkers.clear();
        this.activeTaskCount = 0;
        this.updateWorkerStatus();
    }
}
