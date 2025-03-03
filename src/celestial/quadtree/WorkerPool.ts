import { blobURL } from "./MeshWorkerNew";

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
    private maxWorkers: number;
    private taskQueue: WorkerTask[] = [];
    private busyWorkers: Set<Worker> = new Set();
    private workerStatusTimeout: number | null = null;

    constructor(maxWorkers: number) {
        this.maxWorkers = maxWorkers;
        // Précrée les Workers
        for (let i = 0; i < maxWorkers; i++) {
            // const worker = new Worker(
            //     new URL("./MeshWorker", import.meta.url),
            //     { type: "module" }
            // );
            const worker = new Worker(blobURL, { type: "module" });

            worker.onmessage = (event: MessageEvent) => {
                this.busyWorkers.delete(worker);
                // Récupérer la tâche associée au Worker (nous devons la transmettre par closure)
                if ((worker as WorkerWithTask).currentTask) {
                    const callback = (worker as WorkerWithTask).currentTask!
                        .callback;
                    callback(event.data);
                    delete (worker as WorkerWithTask).currentTask;
                }

                // Lance la prochaine tâche si disponible
                this.updateWorkerStatus();
                this.scheduleNext();
            };

            worker.onerror = (error) => {
                console.error("[Worker Error]", error);
                this.busyWorkers.delete(worker);
                this.updateWorkerStatus();
            };

            this.workers.push(worker);
        }
    }

    // Fonction pour mettre à jour l'élément DOM avec le statut des workers
    private updateWorkerStatus() {
        // Si une mise à jour est déjà programmée, ne rien faire.
        if (this.workerStatusTimeout !== null) {
            return;
        }
        // Planifier une mise à jour dans 500 ms (vous pouvez ajuster ce délai)
        this.workerStatusTimeout = window.setTimeout(() => {
            const busyCount = this.busyWorkers.size;
            const total = this.workers.length;
            const pendingTasks = this.taskQueue.length;
            const info = `Workers busy: ${busyCount} / ${total}, Chunks pending: ${pendingTasks}`;
            const statusDiv = document.getElementById("worker-status");
            if (statusDiv) {
                statusDiv.innerText = info;
            }
            // Réinitialiser le timer
            this.workerStatusTimeout = null;
        }, 25);
    }

    // Ajoute une tâche dans la file et essaie de la lancer immédiatement
    enqueueTask(task: WorkerTask) {
        this.taskQueue.push(task);

        // Trier la file par priorité (distance croissante)
        this.taskQueue.sort((a, b) => a.priority - b.priority);
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    private scheduleNext() {
        // Si aucune tâche en file, rien à faire
        if (this.taskQueue.length === 0) return;

        // Trouver un Worker libre
        const availableWorker = this.workers.find(
            (w) => !this.busyWorkers.has(w)
        );
        if (!availableWorker) {
            this.updateWorkerStatus();
            return; // Tous occupés, attendre qu'un se libère
        }

        // Récupérer la tâche la plus prioritaire
        const task = this.taskQueue.shift()!;
        (availableWorker as WorkerWithTask).currentTask = task;

        this.busyWorkers.add(availableWorker);
        availableWorker.postMessage(task.data);

        this.updateWorkerStatus();
    }

    // Pour nettoyer les Workers
    terminate() {
        this.workers.forEach((w) => w.terminate());
        this.workers = [];
        this.taskQueue = [];
        this.busyWorkers.clear();

        this.updateWorkerStatus();
    }
}
