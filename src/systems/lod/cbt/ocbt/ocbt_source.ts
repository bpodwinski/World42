/**
 * OCBT (pool-CBT) {@link CbtGeometrySource} — the GPU concurrent-binary-tree path
 * (Benyoub & Dupuy, HPG 2024). Owns an {@link OcbtTopologyKernel} (the validated
 * split/merge topology engine), its render mesh + material, and runs entirely on the
 * GPU: per frame it advances the topology one refinement step, decodes every live
 * slot to vertex corners (EvaluateLEB), and draws the implicit mesh. Cost is
 * decoupled from subdivision depth — it scales with the fixed pool capacity, not
 * 2^depth — which is the whole point of OCBT vs the implicit-CBT path.
 *
 * Phase 2 (this file) drives refinement with a FIXED per-face uniform target level
 * (the deterministic, validated predicate from the Phase 1c cross-check) so the
 * render pipeline can be brought up and visually verified independently of the
 * camera metric. Phase 3 swaps in a screen-space-area metric classify.
 *
 * WebGPU only.
 */
import { Matrix, Vector3, type Mesh, type Scene, type TransformNode, type WebGPUEngine } from '@babylonjs/core';
import type { CbtFrameParams, CbtGeometryListener, CbtGeometrySource } from '../cbt_geometry_source';
import type { NoiseParams } from '../cbt_noise';
import { OcbtTopologyKernel } from './ocbt_topology_kernel';
import { buildOcbtRenderMaterial, createOcbtTemplateMesh, type OcbtRenderMaterial } from './ocbt_render_material';

export type OcbtSourceOptions = {
    key: string;
    renderParent: TransformNode;
    radiusSim: number;
    noise: NoiseParams;
    starColor: Vector3;
    starPosWorldDouble: Vector3 | null;
    /** Pool capacity (power of two). Must hold the converged live leaf set. */
    capacity: number;
    /** Split when the leaf's longest edge projects above this many pixels. */
    splitThresholdPx: number;
    /** Merge below this many pixels (hysteresis: < splitThresholdPx). */
    mergeThresholdPx: number;
    /** Backside/horizon cull cosine: cull leaves whose centroid faces away (default -0.1). */
    cullMinDot?: number;
    /** Max subdivision LEVEL (depth - 3). f32 positions cap this in Phase 2 (~16). */
    maxLevel: number;
};

export class OcbtSource implements CbtGeometrySource {
    private readonly kernel: OcbtTopologyKernel;
    private readonly render: OcbtRenderMaterial;
    private readonly mesh: Mesh;
    private readonly starPos: Vector3 | null;
    private readonly listener: CbtGeometryListener;
    private readonly radius: number;
    private readonly splitThresholdPx: number;
    private readonly mergeThresholdPx: number;
    private readonly cullMinDot: number;
    private readonly maxLevel: number;
    private frame = 0;
    private readonly tmpDir = new Vector3();
    private readonly tmpInv = new Matrix();
    private readonly tmpCamLocal = new Vector3();
    private readonly tmpNormal = new Vector3();
    /** 6 frustum planes packed as (nx,ny,nz,d) in camera-relative planet-local space. */
    private readonly frustumF32 = new Float32Array(24);
    /** Anti-pop guard band, in leaf-edge multiples (off-screen kept fine within this band). */
    private static readonly FRUSTUM_GUARD = 1.5;
    /** forcedInstanceCount = min(capacity, liveCount*SAFETY + FLOOR) — absorbs readback lag. */
    private static readonly INSTANCE_SAFETY = 2;
    private static readonly INSTANCE_FLOOR = 8192;

    private ready = false;
    private disposed = false;
    private liveLeafCount = 0;
    private statsReadPending = false;
    private wantWireframe = false;
    private wantDebugLod = false;

    constructor(
        engine: WebGPUEngine,
        scene: Scene,
        opts: OcbtSourceOptions,
        listener: CbtGeometryListener
    ) {
        this.listener = listener;
        this.starPos = opts.starPosWorldDouble;
        this.radius = opts.radiusSim;
        this.splitThresholdPx = opts.splitThresholdPx;
        this.mergeThresholdPx = opts.mergeThresholdPx;
        this.cullMinDot = opts.cullMinDot ?? -0.1;
        this.maxLevel = opts.maxLevel;

        this.kernel = new OcbtTopologyKernel(engine, opts.capacity, 'metric');

        this.render = buildOcbtRenderMaterial(
            scene,
            opts.key,
            { radius: opts.radiusSim, noise: opts.noise, lightColor: opts.starColor },
            this.kernel.heapBuffer,
            this.kernel.positionsBuffer,
            this.kernel.indicesBuffer
        );

        this.mesh = createOcbtTemplateMesh(scene, opts.key);
        this.mesh.parent = opts.renderParent;
        this.mesh.material = this.render.material;
        // Draw nothing until the seed is uploaded: a freshly created StorageBuffer is
        // NOT guaranteed zero-initialized, so rendering before uploadSeed() would read
        // garbage heap ids (ungated) and splatter NaN triangles. Set to capacity once
        // ready (the VS degenerates dead slots).
        this.mesh.forcedInstanceCount = 0;

        // Async init: seed the octahedron + prime the sum-tree once the compute
        // pipelines compile, then decode the seed so the 8 roots render immediately.
        void this.kernel
            .whenReady()
            .then(() => {
                if (this.disposed) return;
                this.kernel.uploadSeed();
                this.kernel.runEvalLeb(); // decode the seed so the metric classify has corners
                this.kernel.runCompact(); // build the seed's draw-index list
                // Re-apply any debug toggles requested before init completed.
                this.render.material.wireframe = this.wantWireframe;
                this.render.setDebugLod(this.wantDebugLod);
                // Start at full capacity (no holes); the readback ramps it DOWN to
                // liveCount*safety as soon as the first count arrives.
                this.mesh.forcedInstanceCount = this.kernel.capacity;
                this.ready = true;
            })
            .catch((e) => {
                // eslint-disable-next-line no-console
                console.error('[OcbtSource] kernel init failed', e);
            });
    }

    refresh(): void {
        // Tree is seeded + the mesh built once the kernel is ready; the per-frame
        // update refines it. Nothing to emit on the main thread.
    }

    requestUpdate(frame: CbtFrameParams): void {
        if (this.disposed || !this.ready) return;

        // Camera in planet-local space = inverse(renderParentWorld) * renderOrigin
        // (the camera sits at the render origin under floating origin).
        frame.renderParentWorldMatrix.invertToRef(this.tmpInv);
        Vector3.TransformCoordinatesToRef(Vector3.ZeroReadOnly, this.tmpInv, this.tmpCamLocal);
        const focalPx = frame.viewportHeightPx / (2 * Math.tan(frame.cameraFovRadians * 0.5));

        this.kernel.setCameraParams({
            camLocal: [this.tmpCamLocal.x, this.tmpCamLocal.y, this.tmpCamLocal.z],
            radius: this.radius,
            focalPx,
            splitThresholdPx: this.splitThresholdPx,
            mergeThresholdPx: this.mergeThresholdPx,
            cullMinDot: this.cullMinDot,
            maxLevel: this.maxLevel
        });

        // Frustum cull: rotate each render-space plane normal into camera-relative
        // planet-local space (R^T·n via the inverse world matrix; renderPos = R·rel, so
        // n·renderPos = (R^T·n)·rel), keep d. Lets the fixed pool concentrate on the
        // visible cone instead of saturating on the whole hemisphere.
        const planes = frame.frustumPlanes;
        if (planes && planes.length >= 6) {
            for (let i = 0; i < 6; i++) {
                const pl = planes[i];
                Vector3.TransformNormalToRef(pl.normal, this.tmpInv, this.tmpNormal);
                this.frustumF32[i * 4 + 0] = this.tmpNormal.x;
                this.frustumF32[i * 4 + 1] = this.tmpNormal.y;
                this.frustumF32[i * 4 + 2] = this.tmpNormal.z;
                this.frustumF32[i * 4 + 3] = pl.d;
            }
            this.kernel.setFrustum(this.frustumF32, OcbtSource.FRUSTUM_GUARD, true);
        } else {
            this.kernel.setFrustum(this.frustumF32, OcbtSource.FRUSTUM_GUARD, false);
        }

        // Alternate split (even) / merge (odd) frames so the two halves never race on
        // the same neighbor buffer; both share the metric classify's candidate lists.
        if ((this.frame++ & 1) === 0) {
            this.kernel.runFrame();
        } else {
            this.kernel.runMergeFrame();
        }
        // Decode the live slots to vertex corners for this frame's draw (and next
        // frame's classify, which reads the positions buffer).
        this.kernel.runEvalLeb();
        // Compact the live slots into the draw-index list so the draw issues liveCount
        // instances (not CAPACITY) — the per-vertex fbm noise makes that the big win.
        this.kernel.runCompact();

        // Light points from the star toward the planet (shader negates it).
        if (this.starPos) {
            this.tmpDir.copyFrom(this.starPos).subtractInPlace(frame.planetCenterWorldDouble);
            if (this.tmpDir.lengthSquared() > 1e-12) {
                this.tmpDir.normalize();
                this.render.setLightDirection(this.tmpDir);
            }
        }

        // Low-frequency, non-blocking live-count readback for HUD telemetry.
        if (!this.statsReadPending) {
            this.statsReadPending = true;
            this.kernel
                .readCount()
                .then((count) => {
                    this.statsReadPending = false;
                    if (this.disposed) return;
                    this.liveLeafCount = count;
                    // Bound the draw to the live count (= compaction count = pool_tree[1]),
                    // over-estimated to absorb readback latency + growth. Jump UP instantly,
                    // ramp DOWN slowly so a single stale-small read can't pop holes.
                    const want = Math.min(
                        this.kernel.capacity,
                        Math.ceil(count * OcbtSource.INSTANCE_SAFETY) + OcbtSource.INSTANCE_FLOOR
                    );
                    const cur = this.mesh.forcedInstanceCount || this.kernel.capacity;
                    this.mesh.forcedInstanceCount =
                        want >= cur ? want : Math.max(want, Math.ceil(cur * 0.9));
                    this.listener(null, {
                        leafCount: count,
                        splitsThisFrame: 0,
                        mergesThisFrame: 0,
                        classifyMs: 0,
                        emitMs: 0
                    });
                })
                .catch(() => {
                    this.statsReadPending = false;
                });
        }
    }

    reset(): void {
        // The GPU engine re-derives geometry each frame; nothing to reset.
    }

    setWireframe(on: boolean): void {
        this.wantWireframe = on;
        this.render.material.wireframe = on;
    }

    setDebugLod(on: boolean): void {
        this.wantDebugLod = on;
        this.render.setDebugLod(on);
    }

    dispose(): void {
        this.disposed = true;
        this.mesh.dispose();
        this.render.dispose();
        this.kernel.dispose();
    }
}
