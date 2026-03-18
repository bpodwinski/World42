import {
    Mesh,
    Observer,
    Scene,
    TransformNode,
    Vector3,
} from '@babylonjs/core';
import type {
    FloatingEntityInterface,
    OriginCamera,
} from '../../../core/camera/camera_manager';
import { globalWorkerPool } from '../workers/global_worker_pool';
import { classifySplitCandidates, measureLeafProjectedAreas } from './cbt_classify';
import { CbtForge, type CbtLeafBuildParams } from './cbt_forge';
import { CbtState, type CbtNode } from './cbt_state';

// ---------------------------------------------------------------------------
// Per-leaf mesh tracking
// ---------------------------------------------------------------------------

type LeafMeshEntry = {
    mesh: Mesh | null;
    pending: boolean;
    /** Monotonic token — reject stale async results. */
    token: number;
    /** Parent node id at time of creation (for merge tracking). */
    parentId: number | null;
};

/**
 * Mesh kept visible while its replacement leaf meshes are loading.
 * Prevents holes during split/merge transitions.
 */
type RetiringMesh = {
    mesh: Mesh;
    /** Original node id this mesh belonged to. */
    nodeId: number;
    /** For merge: the parent that became a leaf and needs a mesh. */
    parentId: number | null;
};

// ---------------------------------------------------------------------------
// CbtPlanet
// ---------------------------------------------------------------------------

export type CbtPlanetOptions = {
    key: string;
    entity: FloatingEntityInterface;
    renderParent: TransformNode;
    radiusSim: number;
    maxDepth: number;
    minDepth?: number;
    resolution?: number;
    maxSplitsPerFrame: number;
    maxMergesPerFrame?: number;
    splitThresholdPx2: number;
    splitHysteresis: number;
    starPosWorldDouble: Vector3 | null;
    starColor: Vector3;
    starIntensity: number;
};

export class CbtPlanet {
    readonly key: string;
    readonly entity: FloatingEntityInterface;
    readonly radiusSim: number;
    readonly starPosWorldDouble: Vector3 | null;

    private state: CbtState;
    private forge: CbtForge;
    private leafMeshes = new Map<number, LeafMeshEntry>();
    private retiringMeshes: RetiringMesh[] = [];
    private nextToken = 1;

    private readonly renderParent: TransformNode;
    private readonly resolution: number;
    private readonly maxDepth: number;
    private readonly maxSplitsPerFrame: number;
    private readonly maxMergesPerFrame: number;
    private readonly splitThresholdPx2: number;
    private readonly splitHysteresis: number;
    private readonly starColor: Vector3;
    private readonly starIntensity: number;

    constructor(
        private scene: Scene,
        private camera: OriginCamera,
        opts: CbtPlanetOptions
    ) {
        this.key = opts.key;
        this.entity = opts.entity;
        this.radiusSim = opts.radiusSim;
        this.renderParent = opts.renderParent;
        this.starPosWorldDouble = opts.starPosWorldDouble;
        this.starColor = opts.starColor;
        this.starIntensity = opts.starIntensity;
        this.resolution = opts.resolution ?? 32;
        this.maxDepth = opts.maxDepth;
        this.maxSplitsPerFrame = opts.maxSplitsPerFrame;
        this.maxMergesPerFrame = opts.maxMergesPerFrame ?? opts.maxSplitsPerFrame;
        this.splitThresholdPx2 = opts.splitThresholdPx2;
        this.splitHysteresis = opts.splitHysteresis;

        this.state = new CbtState(opts.radiusSim, opts.maxDepth, opts.minDepth ?? 0);
        this.forge = new CbtForge(scene, globalWorkerPool);

        // Request meshes for initial leaves
        this.syncLeafMeshes();
    }

    estimatePriority(camera: OriginCamera): number {
        return Vector3.Distance(camera.doublepos, this.entity.doublepos);
    }

    resetNow(): void {
        // Dispose all leaf meshes and rebuild from scratch
        for (const entry of this.leafMeshes.values()) {
            entry.mesh?.dispose();
            entry.token = -1; // invalidate pending
        }
        this.leafMeshes.clear();
        for (const r of this.retiringMeshes) r.mesh.dispose();
        this.retiringMeshes = [];
        this.syncLeafMeshes();
    }

    private _debugTimer = 0;

    update(deadline: number): void {
        if (performance.now() >= deadline) return;

        const leaves = this.state.getLeafNodes();
        const leafMetrics = measureLeafProjectedAreas({
            leaves,
            cameraWorldDouble: this.camera.doublepos,
            planetCenterWorldDouble: this.entity.doublepos,
            renderParentWorldMatrix: this.renderParent.getWorldMatrix(),
            viewportHeightPx: Math.max(1, this.scene.getEngine().getRenderHeight()),
            cameraFovRadians: this.camera.fov,
        });

        const candidates = classifySplitCandidates({
            leaves,
            cameraWorldDouble: this.camera.doublepos,
            planetCenterWorldDouble: this.entity.doublepos,
            renderParentWorldMatrix: this.renderParent.getWorldMatrix(),
            viewportHeightPx: Math.max(1, this.scene.getEngine().getRenderHeight()),
            cameraFovRadians: this.camera.fov,
            splitThresholdPx2: this.splitThresholdPx2,
            splitHysteresis: this.splitHysteresis,
        });

        const splitCount = this.state.splitByPriority(
            candidates.map((c) => c.nodeId),
            this.maxSplitsPerFrame
        );

        const mergeThresholdPx2 = this.splitThresholdPx2 * this.splitHysteresis;

        // Debug log every ~60 frames
        if (++this._debugTimer % 60 === 0) {
            const maxArea = leafMetrics.reduce((m, l) => Math.max(m, l.projectedAreaPx2), 0);
            const maxLevel = leaves.reduce((m, l) => Math.max(m, l.level), 0);
            const dist = Vector3.Distance(this.camera.doublepos, this.entity.doublepos);
            console.log(
                `[cbt][${this.key}] leaves=${leaves.length} maxLevel=${maxLevel}` +
                ` candidates=${candidates.length} splits=${splitCount}` +
                ` maxAreaPx2=${maxArea.toFixed(1)} dist=${dist.toFixed(1)}` +
                ` splitTh=${this.splitThresholdPx2} mergeTh=${mergeThresholdPx2.toFixed(1)}`
            );
        }
        const parentAgg = new Map<number, { children: number; maxAreaPx2: number }>();
        for (const metric of leafMetrics) {
            if (metric.parentId === null) continue;
            const prev = parentAgg.get(metric.parentId) ?? { children: 0, maxAreaPx2: 0 };
            prev.children++;
            prev.maxAreaPx2 = Math.max(prev.maxAreaPx2, metric.projectedAreaPx2);
            parentAgg.set(metric.parentId, prev);
        }

        const mergeParentIds = Array.from(parentAgg.entries())
            .filter(([, agg]) => agg.children === 2 && agg.maxAreaPx2 <= mergeThresholdPx2)
            .sort((a, b) => a[1].maxAreaPx2 - b[1].maxAreaPx2)
            .map(([parentId]) => parentId);

        this.state.mergeByParentPriority(mergeParentIds, this.maxMergesPerFrame);

        // Sync per-leaf meshes with current tree state
        this.syncLeafMeshes();
    }

    dispose(): void {
        for (const entry of this.leafMeshes.values()) {
            entry.mesh?.dispose();
            entry.token = -1;
        }
        this.leafMeshes.clear();
        for (const r of this.retiringMeshes) r.mesh.dispose();
        this.retiringMeshes = [];
    }

    // ------------------------------------------------------------------
    // Per-leaf mesh lifecycle
    // ------------------------------------------------------------------

    private syncLeafMeshes(): void {
        const currentLeaves = this.state.getLeafNodes();
        const currentIds = new Set(currentLeaves.map((l) => l.id));

        // Retire meshes for nodes that are no longer leaves
        for (const [id, entry] of this.leafMeshes) {
            if (!currentIds.has(id)) {
                if (entry.mesh) {
                    // Keep the mesh visible until replacements are ready
                    this.retiringMeshes.push({
                        mesh: entry.mesh,
                        nodeId: id,
                        parentId: entry.parentId,
                    });
                }
                entry.token = -1; // invalidate any pending async result
                this.leafMeshes.delete(id);
            }
        }

        // Request meshes for new leaves
        for (const leaf of currentLeaves) {
            if (!this.leafMeshes.has(leaf.id)) {
                this.requestLeafMesh(leaf);
            }
        }

        // Dispose retiring meshes whose replacements are all ready
        this.retiringMeshes = this.retiringMeshes.filter((retiring) => {
            const node = this.state.getNode(retiring.nodeId);
            if (node && !node.isLeaf) {
                // SPLIT case: node still in tree as internal node.
                // Keep mesh until all descendant leaves have meshes.
                if (this.allDescendantLeavesReady(retiring.nodeId)) {
                    retiring.mesh.dispose();
                    return false;
                }
                return true;
            }
            // MERGE case: node was removed from tree, parent became a leaf.
            if (retiring.parentId !== null) {
                const parentEntry = this.leafMeshes.get(retiring.parentId);
                if (parentEntry?.mesh) {
                    retiring.mesh.dispose();
                    return false;
                }
                return true;
            }
            // Unknown state — dispose to prevent leaks
            retiring.mesh.dispose();
            return false;
        });
    }

    /** Check if every leaf descendant of `nodeId` has a loaded mesh. */
    private allDescendantLeavesReady(nodeId: number): boolean {
        const node = this.state.getNode(nodeId);
        if (!node) return true;
        if (node.isLeaf) {
            const entry = this.leafMeshes.get(nodeId);
            return entry?.mesh != null;
        }
        return (
            (node.leftId !== null && this.allDescendantLeavesReady(node.leftId)) &&
            (node.rightId !== null && this.allDescendantLeavesReady(node.rightId))
        );
    }

    private requestLeafMesh(leaf: CbtNode): void {
        const token = this.nextToken++;
        const entry: LeafMeshEntry = {
            mesh: null,
            pending: true,
            token,
            parentId: leaf.parentId,
        };
        this.leafMeshes.set(leaf.id, entry);

        const params: CbtLeafBuildParams = {
            v0: [leaf.v0.x, leaf.v0.y, leaf.v0.z],
            v1: [leaf.v1.x, leaf.v1.y, leaf.v1.z],
            v2: [leaf.v2.x, leaf.v2.y, leaf.v2.z],
            resolution: this.resolution,
            radius: this.radiusSim,
            level: leaf.level,
            maxLevel: this.maxDepth,
        };

        this.forge
            .buildLeaf(
                params,
                this.camera.doublepos,
                this.entity,
                this.renderParent,
                this.starPosWorldDouble,
                this.starColor,
                this.starIntensity
            )
            .then((mesh) => {
                const current = this.leafMeshes.get(leaf.id);
                if (!current || current.token !== token) {
                    // Leaf was merged/split while worker was busy — discard result
                    mesh.dispose();
                    return;
                }
                current.mesh = mesh;
                current.pending = false;
            })
            .catch((err) => {
                console.warn(`[cbt] mesh build failed for leaf ${leaf.id}:`, err);
                const current = this.leafMeshes.get(leaf.id);
                if (current && current.token === token) {
                    current.pending = false;
                }
            });
    }
}

// ---------------------------------------------------------------------------
// CbtScheduler (unchanged)
// ---------------------------------------------------------------------------

export type CbtSchedulerOptions = {
    budgetMs?: number;
};

export class CbtScheduler {
    private planets: CbtPlanet[] = [];
    private observer: Observer<Scene> | null = null;
    private budgetMs: number;
    private robin = 0;

    constructor(
        private scene: Scene,
        private camera: OriginCamera,
        planets: CbtPlanet[],
        options: CbtSchedulerOptions = {}
    ) {
        this.planets = planets;
        this.budgetMs = options.budgetMs ?? 2;
    }

    setPlanets(planets: CbtPlanet[]): void {
        this.planets = planets;
        this.robin = 0;
    }

    start(): void {
        if (this.observer) return;
        this.observer = this.scene.onBeforeRenderObservable.add(this.tick);
    }

    stop(): void {
        if (!this.observer) return;
        this.scene.onBeforeRenderObservable.remove(this.observer);
        this.observer = null;
    }

    resetNow(): void {
        for (const planet of this.planets) {
            planet.resetNow();
        }
    }

    dispose(): void {
        this.stop();
        for (const planet of this.planets) {
            planet.dispose();
        }
        this.planets = [];
    }

    private tick = (): void => {
        const count = this.planets.length;
        if (!count) return;

        const deadline = performance.now() + this.budgetMs;
        for (let i = 0; i < count; i++) {
            if (performance.now() >= deadline) break;
            const planet = this.planets[(this.robin + i) % count];
            planet.update(deadline);
        }
        this.robin = (this.robin + 1) % Math.max(1, count);
    };
}
