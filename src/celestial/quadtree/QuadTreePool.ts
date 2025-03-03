import { Scene } from "@babylonjs/core";
import { Bounds, Face, QuadTree } from "./QuadTree";
import { OriginCamera } from "../../utils/OriginCamera";

export class QuadTreePool {
    private pool: QuadTree[] = [];
    private maxPoolSize: number;

    constructor(maxPoolSize: number = 100) {
        this.maxPoolSize = maxPoolSize;
    }

    acquire(
        scene: Scene,
        camera: OriginCamera,
        bounds: Bounds,
        level: number,
        maxLevel: number,
        radius: number,
        resolution: number,
        face: Face,
        parent: QuadTree | null = null
    ): QuadTree {
        if (this.pool.length > 0) {
            const quadTree = this.pool.pop()!;
            quadTree.scene = scene;
            quadTree.camera = camera;
            quadTree.bounds = bounds;
            quadTree.level = level;
            quadTree.maxLevel = maxLevel;
            quadTree.radius = radius;
            quadTree.resolution = resolution;
            quadTree.face = face;
            quadTree.parent = parent;
            quadTree.children = null;
            quadTree.mesh = quadTree.createMesh();
            if (parent) {
                quadTree.mesh.parent = parent.mesh;
            }
        }

        return new QuadTree(
            scene,
            camera,
            bounds,
            level,
            maxLevel,
            radius,
            resolution,
            face,
            this,
            parent
        );
    }

    release(quadTree: QuadTree): void {
        if (this.pool.length < this.maxPoolSize) {
            quadTree.deactivate();
            this.pool.push(quadTree);
        } else {
            quadTree.dispose();
        }
    }
}
