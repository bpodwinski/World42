import {
    UniversalCamera,
    Vector3,
    Scene,
    TransformNode,
    MeshBuilder,
    Color3,
    LinesMesh,
} from "@babylonjs/core";

export interface FloatingEntityInterface extends TransformNode {
    doublepos: Vector3;
    update(cam: OriginCamera): void;
}

/**
 * A floating-origin camera that remains fixed at the origin (0, 0, 0), while its attached entities are moved according to their high-precision positions
 */
export class OriginCamera extends UniversalCamera {
    public debugMode: boolean = false;
    private _doubleposLine: LinesMesh | null = null;
    private _doubletgtLine: LinesMesh | null = null;
    private _floatingDebugLines: LinesMesh[] = [];

    // List of floating entities managed by this camera
    private _floatingEntities: FloatingEntity[] = [];

    // High-precision position.
    private _doublepos: Vector3 = new Vector3();

    /**
     * Gets the camera's high-precision position
     */
    public get doublepos(): Vector3 {
        return this._doublepos;
    }
    /**
     * Sets the camera's high-precision position
     */
    public set doublepos(pos: Vector3) {
        this._doublepos.copyFrom(pos);
    }

    // High-precision target
    private _doubletgt: Vector3 = new Vector3();

    /**
     * Gets the camera's high-precision target
     */
    public get doubletgt(): Vector3 {
        return this._doubletgt;
    }

    /**
     * Sets the camera's high-precision target. The actual target is computed as the difference between the high-precision target and the high-precision position
     */
    public set doubletgt(tgt: Vector3) {
        this._doubletgt.copyFrom(tgt);
        //this.setTarget(this._doubletgt.subtract(this._doublepos));
    }

    /**
     * Creates a new floating-origin camera
     *
     * @param name - The name of the camera
     * @param position - The initial high-precision position
     * @param scene - The Babylon.js scene
     */
    constructor(name: string, position: Vector3, scene: Scene) {
        // Initialize the actual camera position at the origin
        super(name, Vector3.Zero(), scene);

        // Store the high-precision position
        this.doublepos = position;

        // Before evaluating active meshes each frame, update the high-precision position and adjust the positions of all managed entities
        scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
            // Add the accumulated movement to the high-precision position
            this.doublepos.addInPlace(this.position);

            // Reset the actual camera position back to the origin
            this.position.set(0, 0, 0);

            // Update all attached floating entities
            for (let entity of this._floatingEntities) {
                entity.update(this);
            }

            if (this.debugMode) {
                this.updateDebugVisuals();
            }
        });
    }

    /**
     * Adds a floating entity to be managed by this camera
     *
     * @param entity - The floating entity to add
     */
    public add(entity: FloatingEntity): void {
        this._floatingEntities.push(entity);
    }

    private updateDebugVisuals(): void {
        const scene = this.getScene();

        // doublepos line: [0, 0, 0] -> doublepos
        const dp = this.doublepos; // pas de clone, on ne le modifie pas ici
        const dpPts = [Vector3.Zero(), dp];

        if (!this._doubleposLine) {
            this._doubleposLine = MeshBuilder.CreateLines("doubleposLine", { points: dpPts }, scene) as LinesMesh;
            this._doubleposLine.color = Color3.Red();
        } else {
            MeshBuilder.CreateLines("doubleposLine", { points: dpPts, instance: this._doubleposLine }, scene);
        }

        // doubletgt relatif : (doubletgt - doublepos)
        const dt = this.doubletgt.subtract(this.doublepos);
        const dtPts = [Vector3.Zero(), dt];

        if (!this._doubletgtLine) {
            this._doubletgtLine = MeshBuilder.CreateLines("doubletgtLine", { points: dtPts }, scene) as LinesMesh;
            this._doubletgtLine.color = Color3.Blue();
        } else {
            MeshBuilder.CreateLines("doubletgtLine", { points: dtPts, instance: this._doubletgtLine }, scene);
        }
    }
}

/**
 * A floating entity whose position is maintained in high precision. The entity updates its relative position based on the camera's high-precision position
 */
export class FloatingEntity extends TransformNode {
    // High-precision position.
    private _doublepos: Vector3 = new Vector3();

    /**
     * Gets the entity's high-precision position
     */
    public get doublepos(): Vector3 {
        return this._doublepos;
    }

    /**
     * Sets the entity's high-precision position
     */
    public set doublepos(pos: Vector3) {
        this._doublepos.copyFrom(pos);
    }

    /**
     * Creates a new floating entity
     *
     * @param name - The name of the entity
     * @param scene - The Babylon.js scene
     */
    constructor(name: string, scene: Scene) {
        super(name, scene);
    }

    /**
     * Updates the entity's position relative to the camera's high-precision position
     *
     * @param cam - The floating-origin camera
     */
    public update(camera: OriginCamera): void {
        this.doublepos.subtractToRef(camera.doublepos, this.position);
    }
}
