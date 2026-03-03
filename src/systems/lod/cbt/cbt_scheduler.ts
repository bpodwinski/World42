import {
    Matrix,
    Mesh,
    Observer,
    Scene,
    ShaderMaterial,
    TransformNode,
    Vector3,
    VertexData,
} from '@babylonjs/core';
import type {
    FloatingEntityInterface,
    OriginCamera,
} from '../../../core/camera/camera_manager';
import { TerrainShader } from '../../../game_objects/planets/rocky_planet/terrains_shader';
import { classifySplitCandidates } from './cbt_classify';
import { emitMeshFromLeaves } from './cbt_emit';
import { CbtState } from './cbt_state';

export type CbtPlanetOptions = {
    key: string;
    entity: FloatingEntityInterface;
    renderParent: TransformNode;
    radiusSim: number;
    maxDepth: number;
    maxSplitsPerFrame: number;
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
    private material: ShaderMaterial | null = null;
    private state: CbtState;
    private pendingFullRefresh = true;
    private shadowAttached = false;

    private readonly renderParent: TransformNode;
    private readonly starColor: Vector3;
    private readonly starIntensity: number;
    private readonly maxSplitsPerFrame: number;
    private readonly splitThresholdPx2: number;
    private readonly splitHysteresis: number;

    private readonly tmpWorldInv = new Matrix();
    private readonly tmpCameraLocal = new Vector3();
    private readonly tmpRotatedLocal = new Vector3();
    private readonly tmpLightDir = new Vector3();
    private readonly tmpLightDirLocal = new Vector3();

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
        this.starColor = opts.starColor.clone();
        this.starIntensity = opts.starIntensity;
        this.maxSplitsPerFrame = opts.maxSplitsPerFrame;
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

        if (splitCount > 0 || this.pendingFullRefresh) {
            this.rebuildMesh();
            this.pendingFullRefresh = false;
        }

        this.updateMaterialUniforms();
        this.ensureShadowCaster();
    }

    dispose(): void {
        this.material?.dispose();
        this.material = null;
        this.mesh?.dispose();
        this.mesh = null;
        this.shadowAttached = false;
    }

    private rebuildMesh(): void {
        const meshData = emitMeshFromLeaves(this.state.getLeafNodes(), this.radiusSim);

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
        vertexData.applyToMesh(this.mesh, true);
        this.mesh.setVerticesData('morphDelta', meshData.morphDeltas, true, 3);
        this.shadowAttached = false;
    }

    private ensureMaterial(): void {
        if (this.material) return;

        this.material = new TerrainShader(this.scene).create(
            64,
            0,
            1,
            Vector3.Zero(),
            this.radiusSim,
            Vector3.Zero(),
            false,
            false
        ) as ShaderMaterial;

        this.material.setVector3('lightColor', this.starColor);
        this.material.setFloat('lightIntensity', this.starIntensity);
    }

    private updateMaterialUniforms(): void {
        if (!this.material) return;

        this.renderParent.getWorldMatrix().invertToRef(this.tmpWorldInv);

        this.camera.doublepos.subtractToRef(this.entity.doublepos, this.tmpRotatedLocal);
        Vector3.TransformNormalToRef(this.tmpRotatedLocal, this.tmpWorldInv, this.tmpCameraLocal);
        this.material.setVector3('cameraPosition', this.tmpCameraLocal);

        if (this.starPosWorldDouble) {
            this.entity.doublepos.subtractToRef(this.starPosWorldDouble, this.tmpLightDir);
            if (this.tmpLightDir.lengthSquared() < 1e-12) {
                this.tmpLightDir.set(1, 0, 0);
            } else {
                this.tmpLightDir.normalize();
            }

            Vector3.TransformNormalToRef(this.tmpLightDir, this.tmpWorldInv, this.tmpLightDirLocal);
            if (this.tmpLightDirLocal.lengthSquared() < 1e-12) {
                this.tmpLightDirLocal.set(1, 0, 0);
            } else {
                this.tmpLightDirLocal.normalize();
            }
            this.material.setVector3('lightDirection', this.tmpLightDirLocal);
        }
    }

    private ensureShadowCaster(): void {
        if (!this.mesh) return;
        const shadowCtx = TerrainShader.getTerrainShadowContext(this.scene);
        if (!shadowCtx) return;
        if (this.shadowAttached) return;
        const mesh = this.mesh;
        mesh.receiveShadows = true;
        shadowCtx.near.shadowGen.addShadowCaster(mesh);
        shadowCtx.far.shadowGen.addShadowCaster(mesh);
        mesh.onDisposeObservable.add(() => {
            shadowCtx.near.shadowGen.removeShadowCaster(mesh, true);
            shadowCtx.far.shadowGen.removeShadowCaster(mesh, true);
        });
        this.shadowAttached = true;
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
