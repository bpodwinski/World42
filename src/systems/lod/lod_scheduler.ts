import type { Scene } from "@babylonjs/core";
import type { OriginCamera } from "../../core/camera/camera_manager";
import { ChunkTree } from "./chunks/chunk_tree";
import { MinHeap } from "./lod_priority_queue";

export type LodSchedulerOptions = {
    maxConcurrent?: number;      // updates LOD en parallèle
    maxStartsPerFrame?: number;  // jobs démarrés par frame
    rescoreMs?: number;          // re-score complet périodique (ms)
    applyDebugEveryFrame?: boolean;
    /**
     * Maximum CPU time (ms) to spend on LOD updates per frame.
     * Prevents LOD processing from blocking the render thread.
     * Default: 4 ms.
     */
    budgetMs?: number;
};

export class LodScheduler {
    private heap = new MinHeap<ChunkTree>();
    private stampMap = new WeakMap<ChunkTree, number>();
    private inFlight = 0;
    private obs: any = null;

    private maxConcurrent: number;
    private maxStartsPerFrame: number;
    private rescoreMs: number;
    private lastRescore = 0;
    /** Maximum CPU time per frame (ms) for LOD updates. */
    private budgetMs: number;
    /** Round-robin index: next root to process first this tick. */
    private _rootRobin = 0;

    private roots: ChunkTree[] = [];

    private applyDebugEveryFrame: boolean;

    constructor(
        private scene: Scene,
        private camera: OriginCamera,
        roots: ChunkTree[],
        opts: LodSchedulerOptions = {}
    ) {
        this.maxConcurrent = opts.maxConcurrent ?? 2;
        this.maxStartsPerFrame = opts.maxStartsPerFrame ?? 3;
        this.rescoreMs = opts.rescoreMs ?? 250;
        this.applyDebugEveryFrame = opts.applyDebugEveryFrame ?? true;
        this.budgetMs = opts.budgetMs ?? 4;
        this.setRoots(roots);
    }

    setRoots(roots: ChunkTree[]) {
        this.roots = roots;
        this.rebuildQueue();
    }

    /** Appeler après teleport: vide + re-score immédiat */
    resetNow() {
        this.rebuildQueue(true);
    }

    start() {
        if (this.obs) return;
        this.obs = this.scene.onBeforeRenderObservable.add(this.tick);
    }

    stop() {
        if (!this.obs) return;
        this.scene.onBeforeRenderObservable.remove(this.obs);
        this.obs = null;
    }

    private rebuildQueue(force = false) {
        this.heap.clear();
        const now = performance.now();
        this.lastRescore = force ? 0 : now;

        for (const r of this.roots) {
            this.pushOrUpdate(r);
        }
    }

    private pushOrUpdate(node: ChunkTree) {
        const prev = this.stampMap.get(node) ?? 0;
        const stamp = prev + 1;
        this.stampMap.set(node, stamp);

        const key = node.estimatePriority(this.camera); // smaller = higher priority
        this.heap.push({ key, value: node, stamp });
    }

    private tick = () => {
        if (!this.roots.length) return;

        const t0 = performance.now();
        const deadline = t0 + this.budgetMs;

        if (t0 - this.lastRescore > this.rescoreMs) {
            // Re-score complet (simple et robuste)
            this.rebuildQueue();
            this.lastRescore = t0;
        }

        if (this.applyDebugEveryFrame) {
            for (const r of this.roots) r.updateDebugLOD(ChunkTree.debugLODEnabled);
        }

        // Round-robin: itère sur tous les roots en commençant par _rootRobin.
        // S'arrête dès que le budget frame est dépassé.
        // Chaque racine reçoit la deadline pour stopper sa récursion à temps.
        const n = this.roots.length;
        for (let i = 0; i < n; i++) {
            if (performance.now() >= deadline) break;
            const root = this.roots[(this._rootRobin + i) % n];
            root.updateLOD(this.camera, false, deadline).catch(console.error);
        }
        // Avance l'index pour que la prochaine frame commence sur le root suivant
        this._rootRobin = (this._rootRobin + 1) % Math.max(1, n);

        let started = 0;

        while (
            started < this.maxStartsPerFrame &&
            this.inFlight < this.maxConcurrent &&
            performance.now() < deadline
        ) {
            const it = this.heap.pop();
            if (!it) break;

            const curStamp = this.stampMap.get(it.value) ?? 0;
            if (it.stamp !== curStamp) {
                // entrée obsolète
                continue;
            }

            const node = it.value;

            this.inFlight++;
            started++;

            node.updateLOD(this.camera, false, deadline)
                .catch(console.error)
                .finally(() => {
                    this.inFlight--;
                    // Requeue avec priorité fraîche
                    this.pushOrUpdate(node);
                });
        }
    };
}
