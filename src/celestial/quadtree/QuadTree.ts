import { Scene, Mesh, Vector3, ShaderMaterial, Texture } from "@babylonjs/core";
import { Terrain } from "../Terrain";
import { QuadTreePool } from "./QuadTreePool";
import {
    FloatingEntityInterface,
    OriginCamera,
} from "../../utils/OriginCamera";
import { ScaleManager } from "../../utils/ScaleManager";
import { PlanetData } from "../PlanetData";
import { WorkerPool } from "./WorkerPool";

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
                    const finalMesh = Terrain.createMeshFromData(
                        this.scene,
                        meshData,
                        this.face,
                        this.level
                    );
                    // Attacher le mesh à l'entité stable (ex : entMercury)
                    finalMesh.parent = this.parentEntity;

                    const terrainShader = new ShaderMaterial(
                        "terrainShader",
                        this.scene,
                        { vertex: "terrain", fragment: "terrain" },
                        {
                            attributes: ["position", "normal", "uv"],
                            uniforms: [
                                "worldViewProjection",
                                "world",
                                "time",
                                "amplitude",
                                "frequency",
                                "mesh_dim",
                                "lodLevel",
                                "lodRangesLUT",
                                "cameraPosition",
                                "uPlanetCenter",
                                "showUV",
                                "debugUV",
                            ],
                            samplers: [
                                "diffuseTexture",
                                "detailTexture",
                                "normalMap",
                                "heightMap",
                            ],
                        }
                    );

                    terrainShader.setInt("debugLOD", 1);
                    terrainShader.setInt("debugUV", 0);
                    terrainShader.setFloat("time", 0.0);
                    terrainShader.setFloat("amplitude", 0.0);
                    terrainShader.setFloat("frequency", 0.0);
                    terrainShader.setFloat("mesh_dim", this.resolution);
                    terrainShader.setFloat("lodLevel", this.level);
                    terrainShader.setFloat("lodMaxLevel", this.maxLevel);
                    terrainShader.setVector3(
                        "cameraPosition",
                        this.camera.doublepos
                    );

                    const lodRanges: number[] = [];
                    for (let i = 0; i < this.maxLevel; i++) {
                        lodRanges[i] =
                            (ScaleManager.toSimulationUnits(
                                PlanetData.get("Mercury").diameter
                            ) /
                                2) *
                            Math.pow(2, i);
                    }
                    terrainShader.setFloats("lodRangesLUT", lodRanges);
                    terrainShader.setVector3(
                        "uPlanetCenter",
                        PlanetData.get("Mercury").position
                    );

                    terrainShader.setTexture(
                        "heightMap",
                        new Texture("textures/moon_heightmap.ktx2", this.scene)
                    );
                    terrainShader.setFloat("heightFactor", 15.0);

                    terrainShader.setTexture(
                        "diffuseTexture",
                        new Texture("textures/moon_diffuse.ktx2", this.scene)
                    );
                    terrainShader.setFloat("textureScale", 1.0);

                    terrainShader.setTexture(
                        "normalMap",
                        new Texture("textures/moon_normal.ktx2", this.scene)
                    );
                    terrainShader.setFloat("normalScale", 1.0);

                    terrainShader.setTexture(
                        "detailTexture",
                        new Texture("textures/moon_detail.ktx2", this.scene)
                    );
                    terrainShader.setFloat("detailScale", 2.0);
                    terrainShader.setFloat("detailBlend", 1.0);

                    terrainShader.wireframe = true;
                    finalMesh.material = terrainShader;
                    finalMesh.checkCollisions = true;

                    // Réinitialiser le cache et enregistrer le niveau de LOD actuel
                    this.meshPromise = null;
                    this.mesh = finalMesh;
                    this.currentLODLevel = this.level;
                    resolve(finalMesh);
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
