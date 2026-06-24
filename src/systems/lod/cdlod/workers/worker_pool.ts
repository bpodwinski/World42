import { PriorityQueue } from './priority_queue';
import type {
    ChunkMeshData,
    MeshKernelChunkStats,
    MeshKernelErrorPayload,
    MeshKernelRequest,
    MeshKernelResponse,
} from './worker_protocol';
import { MESH_KERNEL_PROTOCOL, isMeshKernelMessage } from './worker_protocol';

type WorkerPoolError = MeshKernelErrorPayload & {
    data?: unknown;
    msg?: MeshKernelResponse;
};

export interface WorkerTask {
    data: MeshKernelRequest;
    priority: number;
    callback: (result: ChunkMeshData, stats?: MeshKernelChunkStats) => void;
    onError?: (err: WorkerPoolError) => void;
}

interface WorkerWithTask extends Worker {
    currentTask?: WorkerTask;
    isReady?: boolean;
}

export class WorkerPool {
    private availableWorkers: WorkerWithTask[] = [];
    private busyWorkers: WorkerWithTask[] = [];
    private taskQueue: PriorityQueue<WorkerTask>;

    private readonly maxWorkers: number;
    private readonly maxConcurrentTasks: number;
    private activeTaskCount = 0;
    private readonly displayStatus: boolean;
    private workerStatusTimeout: number | null = null;

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

            worker.onmessage = (event: MessageEvent<unknown>) => {
                this.handleWorkerMessage(worker, event.data);
            };
            worker.onerror = (error) => {
                console.error('[Worker Error]', error);
                this.handleWorkerError(worker);
            };

            const initMsg: MeshKernelRequest = {
                protocol: MESH_KERNEL_PROTOCOL,
                kind: 'init',
                id: `init-${i}`,
                payload: {},
            };
            worker.postMessage(initMsg);

            this.busyWorkers.push(worker);
        }
    }

    enqueueTask(task: WorkerTask): void {
        this.taskQueue.push(task);
        this.updateWorkerStatus();
        this.scheduleNext();
    }

    private scheduleNext(): void {
        if (this.activeTaskCount >= this.maxConcurrentTasks) {
            this.updateWorkerStatus();
            return;
        }
        if (this.taskQueue.size() === 0) return;
        if (this.availableWorkers.length === 0) {
            this.updateWorkerStatus();
            return;
        }

        const task = this.taskQueue.pop();
        const worker = this.availableWorkers.shift();
        if (!task || !worker) return;

        worker.currentTask = task;
        this.markWorkerBusy(worker);
        this.activeTaskCount++;
        worker.postMessage(task.data);
        this.updateWorkerStatus();
    }

    private handleWorkerMessage(worker: WorkerWithTask, data: unknown): void {
        if (!isMeshKernelMessage(data)) {
            this.finishTaskWithError(worker, {
                code: 'protocol_error',
                message: 'Non-protocol worker message',
                data,
            });
            return;
        }

        const msg = data as MeshKernelResponse;
        if (msg.kind === 'ready') {
            worker.isReady = true;
            this.markWorkerAvailable(worker);
            this.updateWorkerStatus();
            this.scheduleNext();
            return;
        }

        const task = worker.currentTask;
        delete worker.currentTask;

        this.markWorkerAvailable(worker);
        if (task) {
            this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
        }

        if (!task) {
            console.warn('[WorkerPool] Protocol message without currentTask:', msg);
            this.updateWorkerStatus();
            this.scheduleNext();
            return;
        }

        if (msg.kind === 'chunk_result') {
            task.callback(msg.payload.meshData, msg.payload.stats);
        } else {
            if (task.onError) task.onError(msg.payload);
            else console.error('[Worker Task Error]', msg.payload);
        }

        this.updateWorkerStatus();
        this.scheduleNext();
    }

    private handleWorkerError(worker: WorkerWithTask): void {
        this.finishTaskWithError(worker, {
            code: 'worker_error',
            message: 'Worker crashed',
        });
    }

    private finishTaskWithError(worker: WorkerWithTask, err: WorkerPoolError): void {
        const task = worker.currentTask;
        delete worker.currentTask;

        this.markWorkerAvailable(worker);
        if (task) {
            this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
        }

        if (task?.onError) task.onError(err);
        else console.error('[WorkerPool]', err);

        this.updateWorkerStatus();
        this.scheduleNext();
    }

    private markWorkerBusy(worker: WorkerWithTask): void {
        this.removeWorkerFromArray(worker, this.availableWorkers);
        if (!this.busyWorkers.includes(worker)) this.busyWorkers.push(worker);
    }

    private markWorkerAvailable(worker: WorkerWithTask): void {
        this.removeWorkerFromArray(worker, this.busyWorkers);
        if (worker.isReady && !this.availableWorkers.includes(worker)) {
            this.availableWorkers.push(worker);
        }
    }

    private removeWorkerFromArray(worker: WorkerWithTask, arr: WorkerWithTask[]): void {
        const index = arr.indexOf(worker);
        if (index !== -1) arr.splice(index, 1);
    }

    private updateWorkerStatus(): void {
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

            const statusDiv = document.getElementById('worker-status');
            if (statusDiv) statusDiv.innerText = info;

            this.workerStatusTimeout = null;
        }, 250);
    }
}
