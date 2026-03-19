import type { Observer, Scene } from "@babylonjs/core";
import type { OriginCamera } from "../../../core/camera/camera_manager";
import { ChunkNode } from "./cdlod_node";
import { LodConfig } from "../lod_config";

// ---------------------------------------------------------------------------
// MinHeap (priority queue for LOD scheduling)
// ---------------------------------------------------------------------------

export type HeapItem<T> = { key: number; value: T; stamp: number };

/** Min-heap by key */
export class MinHeap<T> {
    private a: HeapItem<T>[] = [];

    size() { return this.a.length; }

    push(it: HeapItem<T>) {
        const a = this.a;
        a.push(it);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].key <= a[i].key) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }

    pop(): HeapItem<T> | undefined {
        const a = this.a;
        if (!a.length) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (; ;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let m = i;
                if (l < a.length && a[l].key < a[m].key) m = l;
                if (r < a.length && a[r].key < a[m].key) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }

    clear() { this.a.length = 0; }
}

// ---------------------------------------------------------------------------
// LodScheduler (ChunkTree / quad-sphere scheduler)
// ---------------------------------------------------------------------------

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
    private heap = new MinHeap<ChunkNode>();
    private stampMap = new WeakMap<ChunkNode, number>();
    private inFlight = 0;
    private obs: Observer<Scene> | null = null;

    private maxConcurrent: number;
    private maxStartsPerFrame: number;
    private rescoreMs: number;
    private lastRescore = 0;
    /** Maximum CPU time per frame (ms) for LOD updates. */
    private budgetMs: number;
    /** Round-robin index: next root to process first this tick. */
    private _rootRobin = 0;

    private roots: ChunkNode[] = [];

    private applyDebugEveryFrame: boolean;

    constructor(
        private scene: Scene,
        private camera: OriginCamera,
        roots: ChunkNode[],
        opts: LodSchedulerOptions = {}
    ) {
        this.maxConcurrent = opts.maxConcurrent ?? 2;
        this.maxStartsPerFrame = opts.maxStartsPerFrame ?? 3;
        this.rescoreMs = opts.rescoreMs ?? 250;
        this.applyDebugEveryFrame = opts.applyDebugEveryFrame ?? true;
        this.budgetMs = opts.budgetMs ?? 4;
        this.setRoots(roots);
    }

    setRoots(roots: ChunkNode[]) {
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

    private pushOrUpdate(node: ChunkNode) {
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
            for (const r of this.roots) {
                r.updateDebugLOD(LodConfig.debugLODEnabled);
                r.updateWireframeOverlay(LodConfig.wireframeOverlay);
            }
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
