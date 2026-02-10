import type { Scene } from "@babylonjs/core";
import type { OriginCamera } from "../../core/camera/camera_manager";
import { ChunkTree } from "./chunks/chunk_tree";

export type LodRunnerOptions = {
    /** Combien de roots max on démarre par frame */
    maxRootsPerFrame?: number;
    /** Combien de updateLOD max en parallèle */
    maxConcurrent?: number;
    /** Appliquer debugLOD sur les roots (propage aux enfants) */
    applyDebugEveryFrame?: boolean;
};

export class LodRunner {
    private roots: ChunkTree[] = [];
    private nextRoot = 0;
    private inFlight = 0;
    private obsToken: any = null;

    private maxRootsPerFrame: number;
    private maxConcurrent: number;
    private applyDebugEveryFrame: boolean;

    constructor(
        private scene: Scene,
        private camera: OriginCamera,
        roots: ChunkTree[],
        opts: LodRunnerOptions = {}
    ) {
        this.roots = roots;
        this.maxRootsPerFrame = opts.maxRootsPerFrame ?? 2;
        this.maxConcurrent = opts.maxConcurrent ?? 2;
        this.applyDebugEveryFrame = opts.applyDebugEveryFrame ?? true;
    }

    setRoots(roots: ChunkTree[]) {
        this.roots = roots;
        this.nextRoot = 0;
    }

    /** À appeler après gros téléport / changement de système si tu veux accélérer le rattrapage */
    boostOnce(extra: number = 4) {
        this.maxRootsPerFrame += extra;
        // Redescend automatiquement après 1 frame
        this.scene.onAfterRenderObservable.addOnce(() => {
            this.maxRootsPerFrame = Math.max(1, this.maxRootsPerFrame - extra);
        });
    }

    start() {
        if (this.obsToken) return;
        this.obsToken = this.scene.onBeforeRenderObservable.add(this.tick);
    }

    stop() {
        if (!this.obsToken) return;
        this.scene.onBeforeRenderObservable.remove(this.obsToken);
        this.obsToken = null;
    }

    private tick = () => {
        if (!this.roots.length) return;

        let started = 0;
        while (
            started < this.maxRootsPerFrame &&
            this.inFlight < this.maxConcurrent
        ) {
            const root = this.roots[this.nextRoot];
            this.nextRoot = (this.nextRoot + 1) % this.roots.length;

            this.inFlight++;
            started++;

            // Ne pas await -> non bloquant (updateLOD await les workers)
            root.updateLOD(this.camera, false)
                .catch(console.error)
                .finally(() => {
                    this.inFlight--;
                });
        }

        if (this.applyDebugEveryFrame) {
            for (const r of this.roots) r.updateDebugLOD(ChunkTree.debugLODEnabled);
        }
    };
}
