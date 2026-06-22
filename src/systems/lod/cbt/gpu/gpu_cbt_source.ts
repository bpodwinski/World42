/**
 * WebGPU {@link CbtGeometrySource} — the GPU CBT path (Dupuy 2021). Unlike the
 * CPU/worker sources, it OWNS its render mesh + material: the mesh is implicit
 * (a 3-vertex template drawn `leafCount` times) and the vertex shader reads the
 * CBT heap storage buffer to generate geometry. No CPU geometry crosses to the
 * listener (it is called once with null + the leaf count, for HUD telemetry).
 *
 * Phase 4 scope: the tree is a STATIC uniform-depth seed (CPU-built, GPU-resident)
 * so the implicit render can be validated end-to-end. The GPU split/merge update
 * pass (Phase 3) will replace the static seed with camera-driven refinement.
 */
import { Mesh, Vector3, type Scene, type TransformNode, type WebGPUEngine } from '@babylonjs/core';
import type {
    CbtFrameParams,
    CbtGeometryListener,
    CbtGeometrySource,
} from '../cbt_geometry_source';
import type { NoiseParams } from '../cbt_noise';
import { CbtCpuHeap } from './gpu_cbt_buffers';
import { GpuCbtKernel } from './gpu_cbt_kernel';
import {
    buildGpuCbtRenderMaterial,
    createImplicitTemplateMesh,
    type GpuCbtRenderMaterial,
} from './gpu_cbt_render_material';

export type GpuCbtSourceOptions = {
    key: string;
    renderParent: TransformNode;
    radiusSim: number;
    noise: NoiseParams;
    starColor: Vector3;
    starPosWorldDouble: Vector3 | null;
    /** CBT max depth (heap buffer size). */
    maxDepth?: number;
    /** Static uniform seed depth for the Phase 4 render milestone. */
    seedDepth?: number;
};

export class GpuCbtSource implements CbtGeometrySource {
    private readonly kernel: GpuCbtKernel;
    private readonly render: GpuCbtRenderMaterial;
    private readonly mesh: Mesh;
    private readonly starPos: Vector3 | null;
    private readonly tmpDir = new Vector3();
    private disposed = false;

    constructor(
        engine: WebGPUEngine,
        scene: Scene,
        opts: GpuCbtSourceOptions,
        listener: CbtGeometryListener
    ) {
        const maxDepth = opts.maxDepth ?? 16;
        const seedDepth = Math.min(opts.seedDepth ?? 14, maxDepth);

        this.kernel = new GpuCbtKernel(engine, opts.key, maxDepth);

        // Static uniform-depth tree, fully reduced on CPU and uploaded (no GPU
        // compute needed for the static render; reduction is validated separately).
        const cpu = new CbtCpuHeap(maxDepth);
        cpu.seedLevel(seedDepth);
        cpu.sumReduce();
        const leafCount = cpu.nodeCount();
        this.kernel.uploadHeap(cpu.heap);

        this.render = buildGpuCbtRenderMaterial(
            scene,
            opts.key,
            {
                maxDepth,
                radius: opts.radiusSim,
                noise: opts.noise,
                lightColor: opts.starColor,
            },
            this.kernel.heapBuffer
        );

        this.mesh = createImplicitTemplateMesh(scene, opts.key);
        this.mesh.parent = opts.renderParent;
        this.mesh.material = this.render.material;
        this.mesh.forcedInstanceCount = leafCount;

        this.starPos = opts.starPosWorldDouble;

        // Telemetry only (no CPU geometry).
        listener(null, {
            leafCount,
            splitsThisFrame: 0,
            mergesThisFrame: 0,
            classifyMs: 0,
            emitMs: 0,
        });
    }

    refresh(): void {
        // Mesh + tree built in the constructor; nothing to emit.
    }

    requestUpdate(frame: CbtFrameParams): void {
        if (this.disposed || !this.starPos) return;
        // Light points from the star toward the planet (shader negates it).
        this.tmpDir.copyFrom(this.starPos).subtractInPlace(frame.planetCenterWorldDouble);
        if (this.tmpDir.lengthSquared() > 1e-12) {
            this.tmpDir.normalize();
            this.render.setLightDirection(this.tmpDir);
        }
    }

    reset(): void {
        // Static tree — nothing to reset yet (Phase 3 will re-seed/refine).
    }

    dispose(): void {
        this.disposed = true;
        this.mesh.dispose();
        this.render.dispose();
        this.kernel.dispose();
    }
}
