import { Scene, Mesh, Vector3, ShaderMaterial, Texture } from "@babylonjs/core";
import { Terrain } from "../Terrain";
import { QuadTreePool } from "./QuadTreePool";
import {
    FloatingEntityInterface,
    OriginCamera,
} from "../../utils/OriginCamera";
import { ScaleManager } from "../../utils/ScaleManager";
import { PlanetData } from "../PlanetData";
import { WorkerPool } from "../../utils/WorkerPool";
import { TerrainShader } from "../TerrainShader";

export type Bounds = {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
};

export type Face = "front" | "back" | "left" | "right" | "top" | "bottom";

export const globalWorkerPool = new WorkerPool(
    new URL("../../workers/meshChunkWorker", import.meta.url).href,
    navigator.hardwareConcurrency,
    navigator.hardwareConcurrency,
    true
);

export class QuadTree {
    scene: Scene;
    camera: OriginCamera;
    bounds: Bounds;
    level: number;
    maxLevel: number;
    radius: number;
    resolution: number;
    children: QuadTree[] | null;
    mesh: Mesh | null;
    face: Face;
    parentEntity: FloatingEntityInterface;

    private quadTreePool: QuadTreePool;

    // Cache pour la création asynchrone du mesh
    private meshPromise: Promise<Mesh> | null = null;

    // Garde-fou pour éviter que updateLOD ne soit appelé en parallèle
    private updating: boolean = false;

    // Suivi du niveau de LOD pour lequel le mesh a été créé
    private currentLODLevel: number | null = null;

    constructor(
        scene: Scene,
        camera: OriginCamera,
        bounds: Bounds,
        level: number,
        maxLevel: number,
        radius: number,
        resolution: number,
        face: Face,
        quadTreePool: QuadTreePool = new QuadTreePool(),
        parentEntity: FloatingEntityInterface
    ) {
        this.scene = scene;
        this.camera = camera;
        this.bounds = bounds;
        this.level = level;
        this.maxLevel = maxLevel;
        this.radius = radius;
        this.resolution = resolution;
        this.face = face;
        this.children = null;
        this.quadTreePool = quadTreePool;
        this.mesh = null;
        this.parentEntity = parentEntity;
    }

    /**
     * Crée et renvoie le mesh final asynchrone en utilisant le worker.
     * On utilise un cache pour éviter les duplications.
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
                    const terrainMesh = Terrain.createMeshFromData(
                        this.scene,
                        meshData,
                        this.face,
                        this.level
                    );

                    // Attacher le mesh à l'entité stable (ex : entMercury)
                    terrainMesh.parent = this.parentEntity;
                    terrainMesh.checkCollisions = true;

                    terrainMesh.material = new TerrainShader(this.scene).create(
                        taskData.resolution,
                        this.level,
                        taskData.maxLevel,
                        this.camera.doublepos
                    );

                    // Réinitialiser le cache et enregistrer le niveau de LOD actuel
                    this.meshPromise = null;
                    this.mesh = terrainMesh;
                    this.currentLODLevel = this.level;

                    resolve(terrainMesh);
                },
            });
        });

        return this.meshPromise;
    }

    getCenter(): Vector3 {
        const { uMin, uMax, vMin, vMax } = this.bounds;
        const uCenter = (uMin + uMax) / 2;
        const vCenter = (vMin + vMax) / 2;
        const posCube = Terrain.mapUVtoCube(uCenter, vCenter, this.face);
        return this.parentEntity.doublepos.add(
            posCube.normalize().scale(this.radius)
        );
    }

    private createChild(bounds: Bounds): QuadTree {
        return new QuadTree(
            this.scene,
            this.camera,
            bounds,
            this.level + 1,
            this.maxLevel,
            this.radius,
            this.resolution,
            this.face,
            this.quadTreePool,
            this.parentEntity
        );
    }

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

    disposeChildren(): void {
        if (this.children) {
            this.children.forEach((child) => child.dispose());
            this.children = null;
        }
    }

    deactivate(): void {
        if (this.mesh) {
            this.mesh.setEnabled(false);
        }
        if (this.children) {
            this.children.forEach((child) => child.deactivate());
        }
    }

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

    private fadeOutMesh(mesh: Mesh, duration: number = 500): Promise<void> {
        return new Promise((resolve) => {
            const start = performance.now();
            const material = mesh.material as ShaderMaterial;
            // Assurer que le material supporte l'alpha blending :
            material.transparencyMode = 2; // ALPHA_COMBINE
            const animate = () => {
                const now = performance.now();
                const elapsed = now - start;
                const factor = Math.max(1 - elapsed / duration, 0);
                material.alpha = factor;
                if (factor > 0) {
                    requestAnimationFrame(animate);
                } else {
                    resolve();
                }
            };
            requestAnimationFrame(animate);
        });
    }

    /**
     * Mise à jour du LOD.
     * On attend la création du mesh final pour éviter des créations multiples.
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
            const lodRange = this.radius * Math.pow(0.65, this.level);

            if (minDistance < lodRange && this.level < this.maxLevel) {
                // Si le patch est proche et qu'on peut subdiviser, on passe aux enfants.
                if (!this.children) {
                    this.subdivide();

                    // Ici, this.children est garanti d'être non nul grâce à la subdivision.
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

                // Désactiver le patch actuel pour éviter le recouvrement avec les enfants.
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
                    // Le mesh est déjà à jour pour ce niveau.
                } else if (!this.mesh) {
                    this.mesh = await this.createMeshAsync();
                } else {
                    // Le niveau a changé : créer immédiatement le nouveau mesh,
                    // puis attendre que celui-ci soit rendu avant de supprimer l'ancien.
                    const oldMesh = this.mesh;
                    this.meshPromise = null; // Réinitialiser le cache pour forcer la création d'un nouveau mesh
                    const newMesh = await this.createMeshAsync();
                    newMesh.setEnabled(true);
                    this.mesh = newMesh;

                    // Attendre que le nouveau mesh soit effectivement rendu
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
                    // Une fois le nouveau mesh rendu, supprimer l'ancien
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
}
