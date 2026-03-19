import {
    Color3,
    DirectionalLight,
    Mesh,
    Observer,
    Scene,
    StandardMaterial,
    TransformNode,
    Vector3,
    VertexData,
} from '@babylonjs/core';
import type {
    FloatingEntityInterface,
    OriginCamera,
} from '../../../core/camera/camera_manager';
import { classifySplitCandidates, measureLeafProjectedAreas } from './cbt_classify';
import { emitMeshFromLeaves } from './cbt_emit';
import { CbtState } from './cbt_state';

export type CbtPlanetOptions = {
    key: string;
    entity: FloatingEntityInterface;
    renderParent: TransformNode;
    radiusSim: number;
    maxDepth: number;
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

    private mesh: Mesh | null = null;
    private material: StandardMaterial | null = null;
    private sunLight: DirectionalLight | null = null;
    private state: CbtState;
    private pendingFullRefresh = true;
    private shadowAttached = false;
    private debugLod = false;

    private readonly renderParent: TransformNode;
    private readonly maxSplitsPerFrame: number;
    private readonly maxMergesPerFrame: number;
    private readonly splitThresholdPx2: number;
    private readonly splitHysteresis: number;

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
        this.maxSplitsPerFrame = opts.maxSplitsPerFrame;
        this.maxMergesPerFrame = opts.maxMergesPerFrame ?? opts.maxSplitsPerFrame;
        this.splitThresholdPx2 = opts.splitThresholdPx2;
        this.splitHysteresis = opts.splitHysteresis;
        this.state = new CbtState(opts.radiusSim, opts.maxDepth);

        this.rebuildMesh();
    }

    estimatePriority(camera: OriginCamera): number {
        return Vector3.Distance(camera.doublepos, this.entity.doublepos);
    }

    resetNow(): void {
        this.pendingFullRefresh = true;
    }

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
            candidates.map((candidate) => candidate.nodeId),
            this.maxSplitsPerFrame
        );

        const mergeThresholdPx2 = this.splitThresholdPx2 * this.splitHysteresis;
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

        const mergeCount = this.state.mergeByParentPriority(
            mergeParentIds,
            this.maxMergesPerFrame
        );

        if (splitCount > 0 || mergeCount > 0 || this.pendingFullRefresh) {
            this.rebuildMesh();
            this.pendingFullRefresh = false;
        }

        this.updateSunDirection();
        this.ensureShadowCaster();
    }

    dispose(): void {
        this.sunLight?.dispose();
        this.sunLight = null;
        this.material?.dispose();
        this.material = null;
        this.mesh?.dispose();
        this.mesh = null;
        this.shadowAttached = false;
    }

    private rebuildMesh(): void {
        const meshData = emitMeshFromLeaves(
            this.state.getLeafNodes(),
            this.radiusSim
        );

        if (!this.mesh) {
            this.mesh = new Mesh(`cbt_${this.key}`, this.scene);
            this.mesh.parent = this.renderParent;
            this.mesh.checkCollisions = true;
            this.mesh.alwaysSelectAsActiveMesh = false;
            this.ensureMaterial();
            this.mesh.material = this.material;
        }

        const vertexData = new VertexData();
        vertexData.positions = meshData.positions;
        vertexData.normals = meshData.normals;
        vertexData.uvs = meshData.uvs;
        vertexData.indices = meshData.indices;
        vertexData.colors = meshData.colors;
        vertexData.applyToMesh(this.mesh, true);
        this.mesh.setVerticesData('morphDelta', meshData.morphDeltas, true, 3);
        this.mesh.useVertexColors = this.debugLod;
        this.shadowAttached = false;
    }

    private ensureMaterial(): void {
        if (this.material) return;

        // DirectionalLight oriented from star → planet
        this.sunLight = new DirectionalLight(
            `cbt_sun_${this.key}`,
            new Vector3(0, -1, 0), // placeholder, updated each frame
            this.scene
        );
        this.sunLight.intensity = 1.5;

        this.material = new StandardMaterial(`cbt_mat_${this.key}`, this.scene);
        this.material.backFaceCulling = true;
        this.material.diffuseColor = new Color3(0.6, 0.55, 0.4);
        this.material.specularColor = new Color3(0.05, 0.05, 0.05);
        this.material.useLogarithmicDepth = true;
    }

    setWireframe(on: boolean): void {
        if (this.material) this.material.wireframe = on;
    }

    setDebugLod(on: boolean): void {
        this.debugLod = on;
        if (!this.material) return;
        if (on) {
            this.material.disableLighting = true;
            this.material.emissiveColor = new Color3(1, 1, 1);
            this.material.diffuseColor = new Color3(0, 0, 0);
        } else {
            this.material.disableLighting = false;
            this.material.emissiveColor = new Color3(0, 0, 0);
            this.material.diffuseColor = new Color3(0.6, 0.55, 0.4);
        }
        if (this.mesh) {
            this.mesh.useVertexColors = on;
        }
    }

    private updateSunDirection(): void {
        if (!this.sunLight || !this.starPosWorldDouble) return;

        // Direction = normalize(starPos - planetCenter) → points from star toward planet
        const dir = this.starPosWorldDouble.subtract(this.entity.doublepos);
        if (dir.lengthSquared() < 1e-12) return;
        dir.normalize();
        this.sunLight.direction.copyFrom(dir);
    }

    private ensureShadowCaster(): void {
        if (!this.mesh) return;
        this.mesh.receiveShadows = false;
    }
}

export type CbtSchedulerOptions = {
    budgetMs?: number;
};

export class CbtScheduler {
    private planets: CbtPlanet[] = [];
    private observer: Observer<Scene> | null = null;
    private budgetMs: number;
    private robin = 0;
    private wireframe = false;
    private debugLodMode = false;
    private readonly onKeyDown: (e: KeyboardEvent) => void;

    constructor(
        private scene: Scene,
        private camera: OriginCamera,
        planets: CbtPlanet[],
        options: CbtSchedulerOptions = {}
    ) {
        this.planets = planets;
        this.budgetMs = options.budgetMs ?? 2;

        this.onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'w' || e.key === 'W') {
                this.wireframe = !this.wireframe;
                for (const planet of this.planets) {
                    planet.setWireframe(this.wireframe);
                }
            }
            if (e.key === 'x' || e.key === 'X') {
                this.debugLodMode = !this.debugLodMode;
                for (const planet of this.planets) {
                    planet.setDebugLod(this.debugLodMode);
                }
            }
        };
        window.addEventListener('keydown', this.onKeyDown);
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
        window.removeEventListener('keydown', this.onKeyDown);
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
