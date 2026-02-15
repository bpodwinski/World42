import {
    UniversalCamera,
    Vector3,
    Scene,
    TransformNode,
    MeshBuilder,
    Color3,
    LinesMesh,
    Frustum,
    Plane,
    Mesh,
    Observer,
} from "@babylonjs/core";
import { ScaleManager } from "../scale/scale_manager";

export interface FloatingEntityInterface extends TransformNode {
    doublepos: Vector3; // WorldDouble (simulation units)
    update(cam: OriginCamera): void; // updates render-space transform from camera.doublepos
}

export type OriginCameraOptions = {
    colliderDiameter?: number;
    colliderSegments?: number;
};

/**
 * OriginCamera (floating origin)
 *
 * Repères :
 * - `camera.doublepos` : WorldDouble (simulation units, haute précision)
 * - `camera.position`  : Render-space (floating origin), maintenu à (0,0,0)
 *
 * Pipeline par frame (hook Babylon) :
 * 1) intègre `camera.position` (render delta) dans `doublepos`
 * 2) reset `camera.position` à 0
 * 3) update des FloatingEntities (render = worldDouble - camera.doublepos)
 * 4) calc velocity/speed depuis doublepos
 * 5) debug (optionnel)
 *
 * Optionnel :
 * - `camCollider` (Mesh render-space) gardé à l’origine après l’évaluation active meshes.
 */
export class OriginCamera extends UniversalCamera {
    public debugMode = false;

    // --- WorldDouble state ---
    private readonly _doublepos = new Vector3();
    private readonly _doubletgt = new Vector3();

    // --- Motion (WorldDouble) ---
    private readonly _velocitySim = new Vector3(0, 0, 0);
    private _speedSim = 0;

    private readonly _lastDoublepos = new Vector3();
    private _lastTimestampMs = performance.now();

    // --- Managed floating entities ---
    private readonly _floatingEntities: FloatingEntityInterface[] = [];

    // --- Optional render-space collider ---
    private readonly _camCollider: Mesh;

    // --- Observers (for clean disposal) ---
    private _beforeObs: Observer<Scene> | null = null;
    private _afterObs: Observer<Scene> | null = null;

    // --- Debug lines (render-space visualization helpers) ---
    private _doubleposLine: LinesMesh | null = null;
    private _doubletgtLine: LinesMesh | null = null;
    private readonly _dbgZero = Vector3.Zero(); // stable object
    private readonly _dbgDpPoint = new Vector3();
    private readonly _dbgDtPoint = new Vector3();
    private readonly _dbgPtsDp = [this._dbgZero, this._dbgDpPoint];
    private readonly _dbgPtsDt = [this._dbgZero, this._dbgDtPoint];

    /**
     * Create a floating-origin camera.
     *
     * @param name      camera name
     * @param position  initial WorldDouble position (simulation units)
     * @param scene     Babylon.js scene
     * @param opts      collider options (optional)
     */
    constructor(name: string, position: Vector3, scene: Scene, opts: OriginCameraOptions = {}) {
        super(name, Vector3.Zero(), scene);

        // Init WorldDouble position
        this.doublepos = position;

        // Init velocity history
        this._lastDoublepos.copyFrom(position);
        this._lastTimestampMs = performance.now();

        const diameter = opts.colliderDiameter ?? 0.05;
        const segments = opts.colliderSegments ?? 64;

        this._camCollider = MeshBuilder.CreateSphere(
            `${name}_camCollider`,
            { segments, diameter },
            scene
        ) as Mesh;

        this._camCollider.isVisible = false;
        this._camCollider.isPickable = false;
        this._camCollider.checkCollisions = true;
        this._camCollider.position.set(0, 0, 0);

        this._camCollider.ellipsoid = new Vector3(diameter, diameter, diameter);
        this._camCollider.ellipsoidOffset = new Vector3(diameter, diameter, diameter);

        // Hook: integrate floating origin BEFORE active meshes evaluation
        this._beforeObs = scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
            // (1) integrate render delta into WorldDouble
            this._doublepos.addInPlace(this.position);

            // (2) reset render-space camera to origin
            this.position.set(0, 0, 0);

            // (3) update floating entities (render = worldDouble - camera.doublepos)
            for (const e of this._floatingEntities) e.update(this);

            // (4) velocity/speed from WorldDouble
            this._updateVelocity();

            // (5) debug visuals (optional)
            if (this.debugMode) this._updateDebugVisuals();
        });

        // Hook: keep collider at origin AFTER meshes evaluation (stable)
        this._afterObs = scene.onAfterActiveMeshesEvaluationObservable.add(() => {
            this._camCollider.position.set(0, 0, 0);
        });
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** WorldDouble position (simulation units). */
    public get doublepos(): Vector3 {
        return this._doublepos;
    }
    public set doublepos(pos: Vector3) {
        this._doublepos.copyFrom(pos);
    }

    /** WorldDouble target (simulation units). Render-space look target is (doubletgt - doublepos). */
    public get doubletgt(): Vector3 {
        return this._doubletgt;
    }
    public set doubletgt(tgt: Vector3) {
        this._doubletgt.copyFrom(tgt);
    }

    /** Velocity in simulation units / second (computed from WorldDouble). */
    public get velocitySim(): Vector3 {
        return this._velocitySim;
    }

    /** Speed magnitude in simulation units / second. */
    public get speedSim(): number {
        return this._speedSim;
    }

    /** Render-space collider mesh (kept near origin). Can be null if disabled. */
    public get camCollider(): Mesh {
        return this._camCollider;
    }

    /** Add a floating entity managed by this camera. */
    public add(entity: FloatingEntityInterface): void {
        if (this._floatingEntities.includes(entity)) return;
        this._floatingEntities.push(entity);
    }

    /** Remove a floating entity. */
    public remove(entity: FloatingEntityInterface): void {
        const i = this._floatingEntities.indexOf(entity);
        if (i >= 0) this._floatingEntities.splice(i, 1);
    }

    /** Distance in simulation units to a WorldDouble position or a floating entity. */
    public distanceToSim(target: Vector3 | FloatingEntityInterface): number {
        const tp = target instanceof TransformNode ? (target as any).doublepos : target;
        return Vector3.Distance(this._doublepos, tp);
    }

    public distanceToKm(target: Vector3 | FloatingEntityInterface): number {
        return ScaleManager.toRealUnits(this.distanceToSim(target));
    }

    public distanceToMeters(target: Vector3 | FloatingEntityInterface): number {
        return ScaleManager.kmToMeters(this.distanceToKm(target));
    }

    /** Frustum planes in render-space (same space as camera.getTransformationMatrix()). */
    public getFrustumPlanesToRef(out: Plane[]): Plane[] {
        while (out.length < 6) out.push(new Plane(0, 0, 0, 0));
        Frustum.GetPlanesToRef(this.getTransformationMatrix(), out);
        return out;
    }

    /**
     * WorldDouble -> Render-space
     * render = worldDouble - camera.doublepos
     */
    public toRenderSpace(worldDouble: Vector3, out: Vector3 = new Vector3()): Vector3 {
        worldDouble.subtractToRef(this._doublepos, out);
        return out;
    }

    /**
     * Render-space -> WorldDouble
     * worldDouble = render + camera.doublepos
     */
    public toWorldSpace(renderPos: Vector3, out: Vector3 = new Vector3()): Vector3 {
        renderPos.addToRef(this._doublepos, out);
        return out;
    }

    /** Cleanly detach observers and dispose owned resources (collider + debug lines). */
    public override dispose(doNotRecurse?: boolean, disposeMaterialAndTextures?: boolean): void {
        const scene = this.getScene();

        if (this._beforeObs) {
            scene.onBeforeActiveMeshesEvaluationObservable.remove(this._beforeObs);
            this._beforeObs = null;
        }
        if (this._afterObs) {
            scene.onAfterActiveMeshesEvaluationObservable.remove(this._afterObs);
            this._afterObs = null;
        }

        this._doubleposLine?.dispose();
        this._doubletgtLine?.dispose();
        this._doubleposLine = null;
        this._doubletgtLine = null;

        this._camCollider?.dispose();

        this._floatingEntities.length = 0;

        // Camera.dispose() n'accepte pas d'args dans tes typings
        super.dispose();
    }

    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------

    private _updateVelocity(): void {
        const nowMs = performance.now();
        const dt = (nowMs - this._lastTimestampMs) / 1000.0;

        if (dt > 1e-6) {
            const dx = this._doublepos.x - this._lastDoublepos.x;
            const dy = this._doublepos.y - this._lastDoublepos.y;
            const dz = this._doublepos.z - this._lastDoublepos.z;

            this._velocitySim.set(dx / dt, dy / dt, dz / dt);
            this._speedSim = this._velocitySim.length();

            this._lastDoublepos.copyFrom(this._doublepos);
            this._lastTimestampMs = nowMs;
        }
    }

    /**
     * Debug visuals:
     * - line "doublepos" : 0 -> doublepos (WorldDouble vector shown in render-space; huge values may be off-screen)
     * - line "doubletgt - doublepos" : 0 -> (relative target) in render-space
     */
    private _updateDebugVisuals(): void {
        const scene = this.getScene();

        // Update cached points (avoid new allocations)
        this._dbgDpPoint.copyFrom(this._doublepos);
        this._dbgDtPoint.copyFrom(this._doubletgt).subtractInPlace(this._doublepos);

        if (!this._doubleposLine) {
            this._doubleposLine = MeshBuilder.CreateLines(
                "doubleposLine",
                { points: this._dbgPtsDp },
                scene
            ) as LinesMesh;
            this._doubleposLine.color = Color3.Red();
        } else {
            MeshBuilder.CreateLines(
                "doubleposLine",
                { points: this._dbgPtsDp, instance: this._doubleposLine },
                scene
            );
        }

        if (!this._doubletgtLine) {
            this._doubletgtLine = MeshBuilder.CreateLines(
                "doubletgtLine",
                { points: this._dbgPtsDt },
                scene
            ) as LinesMesh;
            this._doubletgtLine.color = Color3.Blue();
        } else {
            MeshBuilder.CreateLines(
                "doubletgtLine",
                { points: this._dbgPtsDt, instance: this._doubletgtLine },
                scene
            );
        }
    }
}

/**
 * Default floating entity implementation:
 * - Stores a WorldDouble position in `doublepos`
 * - Updates render-space TransformNode.position each frame:
 *   render = worldDouble - camera.doublepos
 */
export class FloatingEntity extends TransformNode implements FloatingEntityInterface {
    private readonly _doublepos = new Vector3();

    public get doublepos(): Vector3 {
        return this._doublepos;
    }
    public set doublepos(pos: Vector3) {
        this._doublepos.copyFrom(pos);
    }

    constructor(name: string, scene: Scene) {
        super(name, scene);
    }

    public update(camera: OriginCamera): void {
        this._doublepos.subtractToRef(camera.doublepos, this.position);
    }
}
