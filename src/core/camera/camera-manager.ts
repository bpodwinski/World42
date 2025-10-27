import {
    UniversalCamera,
    Vector3,
    Scene,
    TransformNode,
    MeshBuilder,
    Color3,
    LinesMesh,
} from "@babylonjs/core";
import { ScaleManager } from "../scale/scale-manager";

export interface FloatingEntityInterface extends TransformNode {
    doublepos: Vector3;
    update(cam: OriginCamera): void;
}

/**
 * Floating-origin camera:
 * - Keeps the render-space camera at (0,0,0)
 * - Maintains a high-precision position in `doublepos`
 * - Updates attached floating entities relative to `doublepos`
 * - Computes velocity and speed each frame from `doublepos`
 */
export class OriginCamera extends UniversalCamera {
    public debugMode: boolean = false;
    private _doubleposLine: LinesMesh | null = null;
    private _doubletgtLine: LinesMesh | null = null;
    private _floatingDebugLines: LinesMesh[] = [];

    // Managed floating entities
    private _floatingEntities: FloatingEntity[] = [];

    // High-precision position/target
    private _doublepos: Vector3 = new Vector3();
    private _doubletgt: Vector3 = new Vector3();

    // Velocity vector (units of simulation per second)
    private _velocitySim: Vector3 = new Vector3(0, 0, 0);

    // Speed magnitude (units of simulation per second)
    private _speedSim: number = 0;

    // Internal previous-frame state for velocity computation
    private _lastDoublepos: Vector3 = new Vector3();
    private _lastTimestampMs: number = performance.now();

    public distanceToSim(target: Vector3 | FloatingEntity): number {
        const tp = target instanceof FloatingEntity ? target.doublepos : target;
        return Vector3.Distance(this.doublepos, tp);
    }

    public distanceToKm(target: Vector3 | FloatingEntity): number {
        const dSim = this.distanceToSim(target);
        return ScaleManager.toRealUnits(dSim); // sim -> km
    }

    public distanceToMeters(target: Vector3 | FloatingEntity): number {
        return ScaleManager.kmToMeters(this.distanceToKm(target)); // km -> m
    }

    /**
     * Current high-precision position (simulation units)
     */
    public get doublepos(): Vector3 {
        return this._doublepos;
    }
    public set doublepos(pos: Vector3) {
        this._doublepos.copyFrom(pos);
    }

    /**
     * Current high-precision target (simulation units). The actual look target in render-space is (doubletgt - doublepos)
     */
    public get doubletgt(): Vector3 {
        return this._doubletgt;
    }

    public set doubletgt(tgt: Vector3) {
        this._doubletgt.copyFrom(tgt);
        // If you want to drive look-at each frame: setTarget(this._doubletgt.subtract(this._doublepos))
    }

    /**
     * Current velocity vector in simulation units per second. This is computed each frame from doublepos delta / dt
     */
    public get velocitySim(): Vector3 {
        return this._velocitySim;
    }

    /**
     * Current speed (magnitude of velocity) in simulation units per second
     */
    public get speedSim(): number {
        return this._speedSim;
    }

    /**
     * Create a floating-origin camera
     * @param name   Camera name
     * @param position Initial high-precision position (simulation units)
     * @param scene  Babylon.js scene
     */
    constructor(name: string, position: Vector3, scene: Scene) {
        // Render-space camera starts at origin (0,0,0)
        super(name, Vector3.Zero(), scene);

        // Store high-precision position
        this.doublepos = position;

        // Initialize velocity history
        this._lastDoublepos.copyFrom(position);
        this._lastTimestampMs = performance.now();

        // Per-frame update: integrate render-space movement into doublepos, reset render-space position, update entities, compute velocity, debug lines
        scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
            // 1) Floating-origin integration:
            // Accumulate render-space delta into high-precision space
            this.doublepos.addInPlace(this.position);

            // Reset render-space camera to origin
            this.position.set(0, 0, 0);

            // 2) Update attached floating entities to reflect new doublepos
            for (let entity of this._floatingEntities) {
                entity.update(this);
            }

            // 3) Compute velocity from doublepos delta / dt
            this._updateVelocity();

            // 4) Debug visuals (optional)
            if (this.debugMode) {
                this.updateDebugVisuals();
            }
        });
    }

    /**
     * Add a floating entity managed by this camera
     */
    public add(entity: FloatingEntity): void {
        this._floatingEntities.push(entity);
    }

    /**
     * Compute velocity & speed (simulation units / second) from doublepos. Uses wall-clock delta between frames
     */
    private _updateVelocity(): void {
        const nowMs = performance.now();
        const dt = (nowMs - this._lastTimestampMs) / 1000.0; // seconds

        if (dt > 0) {
            // delta in simulation units
            const dx = this._doublepos.x - this._lastDoublepos.x;
            const dy = this._doublepos.y - this._lastDoublepos.y;
            const dz = this._doublepos.z - this._lastDoublepos.z;

            // velocity (sim units / s)
            this._velocitySim.set(dx / dt, dy / dt, dz / dt);
            this._speedSim = this._velocitySim.length();

            // persist for next frame
            this._lastDoublepos.copyFrom(this._doublepos);
            this._lastTimestampMs = nowMs;
        }
        // If dt == 0 (very rare), keep previous velocity
    }

    /**
     * Debug helpers: draw lines for doublepos and (doubletgt - doublepos) in render-space from (0,0,0)
     */
    private updateDebugVisuals(): void {
        const scene = this.getScene();

        // Line for doublepos: [0,0,0] -> doublepos
        const dp = this.doublepos;
        const dpPts = [Vector3.Zero(), dp];

        if (!this._doubleposLine) {
            this._doubleposLine = MeshBuilder.CreateLines(
                "doubleposLine",
                { points: dpPts },
                scene
            ) as LinesMesh;
            this._doubleposLine.color = Color3.Red();
        } else {
            MeshBuilder.CreateLines(
                "doubleposLine",
                { points: dpPts, instance: this._doubleposLine },
                scene
            );
        }

        // Line for relative target: (doubletgt - doublepos)
        const dt = this.doubletgt.subtract(this.doublepos);
        const dtPts = [Vector3.Zero(), dt];

        if (!this._doubletgtLine) {
            this._doubletgtLine = MeshBuilder.CreateLines(
                "doubletgtLine",
                { points: dtPts },
                scene
            ) as LinesMesh;
            this._doubletgtLine.color = Color3.Blue();
        } else {
            MeshBuilder.CreateLines(
                "doubletgtLine",
                { points: dtPts, instance: this._doubletgtLine },
                scene
            );
        }
    }
}

/**
 * Floating entity with high-precision position in `doublepos`. Its render-space transform is updated relative to the camera's doublepos
 */
export class FloatingEntity extends TransformNode {
    private _doublepos: Vector3 = new Vector3();

    /** High-precision position (simulation units) */
    public get doublepos(): Vector3 {
        return this._doublepos;
    }
    public set doublepos(pos: Vector3) {
        this._doublepos.copyFrom(pos);
    }

    constructor(name: string, scene: Scene) {
        super(name, scene);
    }

    /**
     * Update render-space position relative to camera.doublepos
     */
    public update(camera: OriginCamera): void {
        this.doublepos.subtractToRef(camera.doublepos, this.position);
    }
}
