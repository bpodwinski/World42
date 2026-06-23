/**
 * WebGPU {@link CbtGeometrySource} — the GPU CBT path (Dupuy 2021). Owns its
 * render mesh + material: the mesh is implicit (a 3-vertex template drawn up to
 * `maxLeaves` times) and the vertex shader reads the CBT heap storage buffer to
 * generate geometry. No CPU geometry, no per-frame upload — the main thread cost
 * is ~0 (a few uniform writes + dispatch calls).
 *
 * Each frame runs, entirely on the GPU: the adaptive update pass (metric-driven
 * forced-diamond split or merge, alternating by parity) → sum-reduction → implicit
 * render. The split/merge are watertight conforming both within each octahedron
 * face and across the 12 seams (see cbt_conform.wgsl). For HUD telemetry, the live
 * leaf count is read back at low frequency (every 30 frames, non-blocking).
 */
import { Matrix, Mesh, Vector3, type Scene, type TransformNode, type WebGPUEngine } from '@babylonjs/core';
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
    /** CBT max depth (heap buffer size + leaf cap = 2^maxDepth). */
    maxDepth: number;
    /** Split when projected leaf area (px^2) exceeds this. */
    splitThresholdPx2: number;
    /** Merge hysteresis (mergeThreshold = splitThreshold * hysteresis). */
    splitHysteresis: number;
    /** Backside-cull split candidates on the far hemisphere (default true). */
    cullBackface?: boolean;
    /** Horizon guard-band cosine for the backside cull (default -0.05). */
    cullMinDot?: number;
    /** Initial uniform seed depth (the tree the GPU then refines). */
    seedDepth?: number;
};

export class GpuCbtSource implements CbtGeometrySource {
    private readonly kernel: GpuCbtKernel;
    private readonly render: GpuCbtRenderMaterial;
    private readonly mesh: Mesh;
    private readonly starPos: Vector3 | null;
    private readonly radius: number;
    private readonly splitThreshold: number;
    private readonly mergeThreshold: number;
    private readonly cullBackface: boolean;
    private readonly cullMinDot: number;
    private readonly tmpDir = new Vector3();
    private readonly tmpInv = new Matrix();
    private readonly tmpCamLocal = new Vector3();
    private readonly listener: CbtGeometryListener;
    private liveLeafCount: number;
    private statsReadPending = false;
    private frame = 0;
    private disposed = false;

    constructor(
        engine: WebGPUEngine,
        scene: Scene,
        opts: GpuCbtSourceOptions,
        listener: CbtGeometryListener
    ) {
        const maxDepth = opts.maxDepth;
        const seedDepth = Math.min(opts.seedDepth ?? 6, maxDepth);
        this.listener = listener;
        this.liveLeafCount = Math.pow(2, seedDepth); // uniform seed; refined live count read back below
        this.radius = opts.radiusSim;
        this.splitThreshold = opts.splitThresholdPx2;
        this.mergeThreshold = opts.splitThresholdPx2 * opts.splitHysteresis;
        this.cullBackface = opts.cullBackface ?? true;
        this.cullMinDot = opts.cullMinDot ?? -0.05;

        this.kernel = new GpuCbtKernel(engine, opts.key, maxDepth);

        // Seed a small uniform tree (CPU-reduced) so something renders before the
        // GPU update refines it.
        const cpu = new CbtCpuHeap(maxDepth);
        cpu.seedLevel(seedDepth);
        cpu.sumReduce();
        this.kernel.uploadHeap(cpu.heap);

        this.render = buildGpuCbtRenderMaterial(
            scene,
            opts.key,
            { maxDepth, radius: opts.radiusSim, noise: opts.noise, lightColor: opts.starColor },
            this.kernel.heapBuffer
        );

        this.mesh = createImplicitTemplateMesh(scene, opts.key);
        this.mesh.parent = opts.renderParent;
        this.mesh.material = this.render.material;
        // Fixed instance cap; the vertex shader degenerates instances beyond the
        // live leaf count.
        this.mesh.forcedInstanceCount = this.kernel.maxLeaves;

        this.starPos = opts.starPosWorldDouble;

        listener(null, {
            leafCount: this.liveLeafCount,
            splitsThisFrame: 0,
            mergesThisFrame: 0,
            classifyMs: 0,
            emitMs: 0,
        });
    }

    refresh(): void {
        // Tree seeded + mesh built in the constructor; the per-frame update refines it.
    }

    requestUpdate(frame: CbtFrameParams): void {
        if (this.disposed) return;

        // Camera in planet-local space = inverse(renderParentWorld) * renderOrigin.
        // The camera sits at the render origin (floating origin), so this is just
        // the translation of the inverse render-parent matrix.
        frame.renderParentWorldMatrix.invertToRef(this.tmpInv);
        Vector3.TransformCoordinatesToRef(Vector3.ZeroReadOnly, this.tmpInv, this.tmpCamLocal);

        const focal =
            frame.viewportHeightPx / (2 * Math.tan(frame.cameraFovRadians * 0.5));

        // Alternate split (even) / merge (odd) frames to keep bitfield writes race-free.
        const parity = this.frame & 1;
        this.frame++;

        this.kernel.runUpdate({
            camLocal: [this.tmpCamLocal.x, this.tmpCamLocal.y, this.tmpCamLocal.z],
            radius: this.radius,
            focal,
            splitThreshold: this.splitThreshold,
            mergeThreshold: this.mergeThreshold,
            parity,
            cullBackface: this.cullBackface,
            cullMinDot: this.cullMinDot,
        });
        this.kernel.runReduction();

        // Light points from the star toward the planet (shader negates it).
        if (this.starPos) {
            this.tmpDir.copyFrom(this.starPos).subtractInPlace(frame.planetCenterWorldDouble);
            if (this.tmpDir.lengthSquared() > 1e-12) {
                this.tmpDir.normalize();
                this.render.setLightDirection(this.tmpDir);
            }
        }

        // HUD telemetry: read the live leaf count back at low frequency (non-blocking
        // — resolves over the render loop, no pipeline stall). Main-thread cost stays
        // ~0; only this occasional small readback touches the CPU.
        if (this.frame % 30 === 0 && !this.statsReadPending) {
            this.statsReadPending = true;
            this.kernel
                .readNodeCount()
                .then((count) => {
                    this.statsReadPending = false;
                    if (this.disposed) return;
                    this.liveLeafCount = count;
                    this.listener(null, {
                        leafCount: count,
                        splitsThisFrame: 0,
                        mergesThisFrame: 0,
                        classifyMs: 0,
                        emitMs: 0,
                    });
                })
                .catch(() => {
                    this.statsReadPending = false;
                });
        }
    }

    reset(): void {
        // The GPU update re-derives the tree each frame; nothing to reset here.
    }

    setWireframe(on: boolean): void {
        this.render.material.wireframe = on;
    }

    setDebugLod(on: boolean): void {
        this.render.setDebugLod(on);
    }

    dispose(): void {
        this.disposed = true;
        this.mesh.dispose();
        this.render.dispose();
        this.kernel.dispose();
    }
}
