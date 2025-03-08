import { Scene, Mesh, Vector3, ShaderMaterial, Texture } from "@babylonjs/core";
import { WorkerPool } from "../../utils/WorkerPool";
import {
    FloatingEntityInterface,
    OriginCamera,
} from "../../utils/OriginCamera";
import { Terrain } from "../Terrain";
import { TerrainShader } from "../TerrainShader";

/**
 * Type defining the UV bounds of a terrain chunk
 *
 * Contains minimum and maximum u and v values
 *
 * @typedef {Bounds}
 */
export type Bounds = {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
};

/**
 * Type defining the possible cube faces
 *
 * @typedef {Face}
 */
export type Face = "front" | "back" | "left" | "right" | "top" | "bottom";

/**
 * Global worker pool for mesh chunk computation
 *
 * Instantiated with the worker script URL and using hardware concurrency for both workers and concurrent tasks
 */
export const globalWorkerPool = new WorkerPool(
    new URL("../../workers/meshChunkWorker", import.meta.url).href,
    navigator.hardwareConcurrency - 1,
    navigator.hardwareConcurrency - 1,
    true
);

/**
 * QuadTree class represents a terrain chunk and manages its hierarchical subdivision
 *
 * Stores spatial information and holds reference to the generated mesh if available
 */
export class QuadTree {
    scene: Scene;
    camera: OriginCamera;
    bounds: Bounds;
    level: number;
    maxLevel: number;
    radius: number;
    center: Vector3;
    resolution: number;
    children: QuadTree[] | null;
    mesh: Mesh | null;
    face: Face;
    parentEntity: FloatingEntityInterface;

    //private quadTreePool: QuadTreePool;

    // Cache for asynchronous mesh creation to avoid duplicate generation
    private meshPromise: Promise<Mesh> | null = null;

    // Guard to prevent concurrent updateLOD calls
    private updating: boolean = false;

    // Keeps track of the LOD level for which the mesh was generated
    private currentLODLevel: number | null = null;

    // Flag to enable or disable debug mode for LOD (passed to the shader)
    public debugLOD: boolean;
    public static debugLODEnabled: boolean = false;

    /**
     * Creates new QuadTree instance
     *
     * @param {Scene} scene - Babylon.js scene used for mesh creation
     * @param {OriginCamera} camera - Camera used for LOD calculations
     * @param {Bounds} bounds - UV bounds of the terrain chunk
     * @param {number} level - Current LOD level
     * @param {number} maxLevel - Maximum LOD level allowed
     * @param {number} radius - Radius of the planet in simulation units
     * @param {Vector3} center - Center position of the chunk (in simulation units)
     * @param {number} resolution - Grid resolution for the chunk
     * @param {Face} face - Cube face for the terrain chunk
     * @param {FloatingEntityInterface} parentEntity - Entity to which the mesh is attached
     * @param {boolean} [debugLOD=false] - Whether to enable LOD debug mode
     */
    constructor(
        scene: Scene,
        camera: OriginCamera,
        bounds: Bounds,
        level: number,
        maxLevel: number,
        radius: number,
        center: Vector3,
        resolution: number,
        face: Face,
        //quadTreePool: QuadTreePool = new QuadTreePool() || null,
        parentEntity: FloatingEntityInterface,
        debugLOD: boolean = false
    ) {
        this.scene = scene;
        this.camera = camera;
        this.bounds = bounds;
        this.level = level;
        this.maxLevel = maxLevel;
        this.radius = radius;
        this.center = center;
        this.resolution = resolution;
        this.face = face;
        this.children = null;
        //this.quadTreePool = quadTreePool;
        this.mesh = null;
        this.parentEntity = parentEntity;
        this.debugLOD = debugLOD;
    }

    /**
     * Asynchronously creates and returns the mesh for the chunk using a worker
     *
     * Uses caching to avoid duplicate mesh creation
     *
     * @returns {Promise<Mesh>} Promise resolving to the generated Mesh
     */
    async createMeshAsync(): Promise<Mesh> {
        if (this.meshPromise) {
            return this.meshPromise;
        }

        this.meshPromise = new Promise<any>((resolve) => {
            const taskData = {
                bounds: this.bounds,
                resolution: this.resolution,
                radius: this.radius,
                face: this.face,
                level: this.level,
                maxLevel: this.maxLevel,
            };

            const center = this.getCenter();
            const priority = Vector3.Distance(center, this.camera.doublepos);

            globalWorkerPool.enqueueTask({
                data: taskData,
                priority: priority,
                callback: (meshData: any) => {
                    const terrainMesh = Terrain.createMeshFromWorker(
                        this.scene,
                        meshData,
                        this.face,
                        this.level
                    );

                    terrainMesh.parent = this.parentEntity;
                    terrainMesh.checkCollisions = true;

                    terrainMesh.material = new TerrainShader(this.scene).create(
                        taskData.resolution,
                        this.level,
                        taskData.maxLevel,
                        this.camera.doublepos,
                        this.radius,
                        this.center,
                        false,
                        QuadTree.debugLODEnabled
                    );

                    /// Reset cache and record current LOD level
                    this.meshPromise = null;
                    this.mesh = terrainMesh;
                    this.mesh.alwaysSelectAsActiveMesh = true; // TODO: Bug due to heightmap GPU bounding box for frustum culling being too low
                    this.currentLODLevel = this.level;

                    resolve(terrainMesh);
                },
            });
        });

        return this.meshPromise;
    }

    /**
     * Returns the center position of the chunk in world space
     *
     * Uses bounds and parent's double position for calculation
     *
     * @returns {Vector3} Center position of the chunk
     */
    getCenter(): Vector3 {
        const { uMin, uMax, vMin, vMax } = this.bounds;
        const uCenter = (uMin + uMax) / 2;
        const vCenter = (vMin + vMax) / 2;
        const posCube = Terrain.mapUVtoCube(uCenter, vCenter, this.face);
        return this.parentEntity.doublepos.add(
            posCube.normalize().scale(this.radius)
        );
    }

    /**
     * Creates a new child QuadTree node with given bounds
     *
     * @param {Bounds} bounds - New bounds for the child node
     * @returns {QuadTree} New child QuadTree node
     */
    private createChild(bounds: Bounds): QuadTree {
        return new QuadTree(
            this.scene,
            this.camera,
            bounds,
            this.level + 1,
            this.maxLevel,
            this.radius,
            this.center,
            this.resolution,
            this.face,
            //this.quadTreePool,
            this.parentEntity,
            this.debugLOD
        );
    }

    /**
     * Subdivides the current node into four child nodes
     *ssss
     * Computes new bounds for each quadrant and creates child QuadTree nodes
     */
    subdivide(): void {
        this.children = [];
        const { uMin, uMax, vMin, vMax } = this.bounds;
        const uMid = (uMin + uMax) / 2;
        const vMid = (vMin + vMax) / 2;

        const boundsTL: Bounds = { uMin, uMax: uMid, vMin: vMid, vMax };
        const boundsTR: Bounds = { uMin: uMid, uMax, vMin: vMid, vMax };
        const boundsBL: Bounds = { uMin, uMax: uMid, vMin, vMax: vMid };
        const boundsBR: Bounds = { uMin: uMid, uMax, vMin, vMax: vMid };

        this.children.push(this.createChild(boundsTL));
        this.children.push(this.createChild(boundsTR));
        this.children.push(this.createChild(boundsBL));
        this.children.push(this.createChild(boundsBR));
    }

    /**
     * Disposes all child nodes and clears the children array
     */
    disposeChildren(): void {
        if (this.children) {
            this.children.forEach((child) => child.dispose());
            this.children = null;
        }
    }

    /**
     * Deactivates the current node and its children by disabling their meshes
     */
    deactivate(): void {
        if (this.mesh) {
            this.mesh.setEnabled(false);
        }
        if (this.children) {
            this.children.forEach((child) => child.deactivate());
        }
    }

    /**
     * Disposes the current node's mesh and recursively disposes its children
     */
    dispose(): void {
        if (this.mesh) {
            this.mesh.dispose();
            this.mesh = null;
        }
        if (this.children) {
            this.children.forEach((child) => child.dispose());
            this.children = null;
        }
    }

    /**
     * Asynchronously updates the level of detail (LOD) for the chunk
     *
     * Waits for final mesh creation to avoid duplicate generation and manages subdivision
     *
     * @param {OriginCamera} camera - Camera used for LOD calculation
     * @param {boolean} [debugMode=false] - Enable or disable debug mode during LOD update
     * @returns {Promise<void>} Promise resolving when LOD update is complete
     */
    async updateLOD(
        camera: OriginCamera,
        debugMode: boolean = false
    ): Promise<void> {
        if (this.updating) return;
        this.updating = true;

        try {
            const { uMin, uMax, vMin, vMax } = this.bounds;
            const center = this.getCenter();
            const cornersUV = [
                { u: uMin, v: vMin },
                { u: uMin, v: vMax },
                { u: uMax, v: vMin },
                { u: uMax, v: vMax },
            ];
            const corners = cornersUV.map(({ u, v }) => {
                const posCube = Terrain.mapUVtoCube(u, v, this.face);
                return this.parentEntity.doublepos.add(
                    posCube.normalize().scale(this.radius)
                );
            });
            const distances = [
                Vector3.Distance(center, camera.doublepos),
                ...corners.map((corner) =>
                    Vector3.Distance(corner, camera.doublepos)
                ),
            ];
            const minDistance = Math.min(...distances);
            const lodRange = this.radius * 2 * Math.pow(0.6, this.level);

            if (minDistance < lodRange && this.level < this.maxLevel) {
                // If chunk is close and can be subdivided, process children
                if (!this.children) {
                    this.subdivide();

                    // Children are guaranteed to exist after subdivision
                    await Promise.all(
                        this.children!.map((child) => child.createMeshAsync())
                    );

                    for (const child of this.children!) {
                        if (child.mesh) {
                            child.mesh.setEnabled(true);
                        }
                    }

                    if (this.mesh) {
                        this.mesh.setEnabled(false);
                    }
                }

                // Disable current mesh to prevent overlap with children
                if (this.mesh) {
                    this.mesh.setEnabled(false);
                }
                await Promise.all(
                    this.children!.map((child) =>
                        child.updateLOD(camera, debugMode)
                    )
                );
            } else {
                if (this.mesh && this.currentLODLevel === this.level) {
                    // Mesh is already up to date for this level
                } else if (!this.mesh) {
                    this.mesh = await this.createMeshAsync();
                } else {
                    // LOD level has changed: create new mesh immediately,
                    // wait for it to render then dispose the old mesh
                    const oldMesh = this.mesh;

                    this.meshPromise = null; // Reset cache to force new mesh creation

                    const newMesh = await this.createMeshAsync();
                    newMesh.setEnabled(true);
                    this.mesh = newMesh;

                    // Wait for new mesh to render
                    await new Promise<void>((resolve) => {
                        const observer = this.scene.onAfterRenderObservable.add(
                            () => {
                                this.scene.onAfterRenderObservable.remove(
                                    observer
                                );
                                resolve();
                            }
                        );
                    });

                    // Once new mesh is rendered, dispose the old mesh
                    oldMesh.dispose();
                }
                if (this.children) {
                    this.disposeChildren();
                }
                if (this.mesh) {
                    this.mesh.setEnabled(true);
                }
            }
        } finally {
            this.updating = false;
        }
    }

    /**
     * Updates the debugLOD uniform on the shader material of this chunk
     * and recursively for all child chunks.
     *
     * @param debugLOD - New value for debugLOD (true: enabled, false: disabled)
     */
    public updateDebugLOD(debugLOD: boolean): void {
        if (this.mesh && this.mesh.material) {
            (this.mesh.material as ShaderMaterial).setInt(
                "debugLOD",
                debugLOD ? 1 : 0
            );
        }
        if (this.children) {
            this.children.forEach((child) => child.updateDebugLOD(debugLOD));
        }
    }
}
