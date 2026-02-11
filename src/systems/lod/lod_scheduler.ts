import type { Scene } from "@babylonjs/core";
import type { OriginCamera } from "../../core/camera/camera_manager";
import { ChunkTree } from "./chunks/chunk_tree";
import { MinHeap } from "./lod_priority_queue";

export type LodSchedulerOptions = {
    maxConcurrent?: number;      // updates LOD en parallèle
    maxStartsPerFrame?: number;  // jobs démarrés par frame
    rescoreMs?: number;          // re-score complet périodique (ms)
    applyDebugEveryFrame?: boolean;
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

        const now = performance.now();
        if (now - this.lastRescore > this.rescoreMs) {
            // Re-score complet (simple et robuste)
            this.rebuildQueue();
            this.lastRescore = now;
        }

        if (this.applyDebugEveryFrame) {
            for (const r of this.roots) r.updateDebugLOD(ChunkTree.debugLODEnabled);
        }

        // Update tous les roots chaque frame (updateLOD est maintenant non-bloquant)
        for (const r of this.roots) {
            r.updateLOD(this.camera, false).catch(console.error);
        }

        let started = 0;

        while (
            started < this.maxStartsPerFrame &&
            this.inFlight < this.maxConcurrent
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

            node.updateLOD(this.camera, false)
                .catch(console.error)
                .finally(() => {
                    this.inFlight--;
                    // Requeue avec priorité fraîche
                    this.pushOrUpdate(node);
                });
        }
    };
}
