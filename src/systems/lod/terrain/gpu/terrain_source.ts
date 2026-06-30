/**
 * TERRAIN (pool-TERRAIN) {@link TerrainGeometrySource} — the GPU concurrent-binary-tree path
 * (Benyoub & Dupuy, HPG 2024). Owns an {@link TerrainTopologyKernel} (the validated
 * split/merge topology engine), its render mesh + material, and runs entirely on the
 * GPU: per frame it advances the topology one refinement step, decodes every live
 * slot to vertex corners (EvaluateLEB), and draws the implicit mesh. Cost is
 * decoupled from subdivision depth — it scales with the fixed pool capacity, not
 * 2^depth — which is the whole point of TERRAIN vs the implicit-TERRAIN path.
 *
 * Phase 2 (this file) drives refinement with a FIXED per-face uniform target level
 * (the deterministic, validated predicate from the Phase 1c cross-check) so the
 * render pipeline can be brought up and visually verified independently of the
 * camera metric. Phase 3 swaps in a screen-space-area metric classify.
 *
 * WebGPU only.
 */
import { Matrix, Vector3, type Mesh, type Scene, type TransformNode, type WebGPUEngine } from '@babylonjs/core';
import type { TerrainFrameParams, TerrainGeometryListener, TerrainGeometrySource } from '../terrain_geometry_source';
import { DEFAULT_CRATERS, type CraterParams, type NoiseParams } from '../terrain_noise';
import type { ResolvedLighting } from '../../../../game_world/stellar_system/planet_lighting';
import { TerrainTopologyKernel } from './terrain_topology_kernel';
import { buildTerrainRenderMaterial, createTerrainTemplateMesh, type TerrainRenderMaterial } from './terrain_render_material';

export type TerrainSourceOptions = {
    key: string;
    renderParent: TransformNode;
    radiusSim: number;
    noise: NoiseParams;
    /** Crater field — baked into both WGSL programs (eval + render) and used by CPU collision. */
    craters?: CraterParams;
    starColor: Vector3;
    starIntensity: number;
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
    /** Min subdivision LEVEL: force-refine the whole sphere to at least this level so it never
     *  collapses to the 8 octahedron roots (faceted limb) when far / merging. */
    minLevel: number;
    /** Per-planet resolved lighting params forwarded to the render material. */
    lighting?: ResolvedLighting;
};

export class TerrainSource implements TerrainGeometrySource {
    private readonly kernel: TerrainTopologyKernel;
    private readonly render: TerrainRenderMaterial;
    private readonly mesh: Mesh;
    private readonly starPos: Vector3 | null;
    private readonly starIntensity: number;
    private readonly listener: TerrainGeometryListener;
    private readonly radius: number;
    private readonly splitThresholdPx: number;
    private readonly mergeThresholdPx: number;
    private readonly cullMinDot: number;
    private readonly maxLevel: number;
    private readonly minLevel: number;
    /** Max radial relief (noise globalAmplitude). Used by the relief-aware horizon cull. The
     *  frustum no longer needs it: the df64 eval now decodes TERRAIN-displaced positions, so
     *  the frustum test is exact (no smooth-sphere vs displaced mismatch). */
    private readonly heightMargin: number;
    private frame = 0;
    /** Frozen camera position (PLANET-LOCAL) the live POSITIONS buffer was last baked against.
     *  The render carries the per-frame residual (anchor - live) in uCamDelta, so the topology +
     *  EvaluateLEB noise pass only re-bakes when the drift exceeds a threshold (NOT every frame —
     *  a spinning planet used to defeat the old per-frame still gate). NaN until the first bake. */
    private readonly anchorCamLocal = new Vector3(NaN, NaN, NaN);
    /** True once anchorCamLocal holds a valid baked frame. */
    private anchorValid = false;
    /** A fixed WORLD axis expressed in PLANET-LOCAL at the anchor — its rotation away from the live
     *  value measures the planet spin since the anchor (catches spin near the rotation axis, where
     *  the camera barely moves in planet-local but the visible cone still sweeps). */
    private readonly anchorRefLocal = new Vector3();
    /** Frames left in a post-jump convergence burst (incremental topology needs ~SETTLE_FRAMES to
     *  fully refine a new view): force a re-bake every frame while > 0. */
    private convergeFrames = 0;
    /** Frames since the last heavy re-bake — drives the Axe 3 throttle (re-bake 1 frame in N
     *  under steady drift; the draw stays exact between via uCamDelta + the world rotation). */
    private framesSinceRebake = 0;
    /** Consecutive frames of STEADY translation-only drift (no rotation / jump / burst) — drives the
     *  OPT-4 adaptive throttle that stretches the re-bake interval base->2x->3x while motion stays slow
     *  and rotation-free. Reset to 0 the moment a rotation or jump appears (cull responsiveness). */
    private steadyDriftFrames = 0;
    /** Live camera planet-local from the previous frame — used to detect discrete jumps (teleport). */
    private readonly lastFrameCamLocal = new Vector3(NaN, NaN, NaN);
    private readonly tmpDir = new Vector3();
    private readonly tmpInv = new Matrix();
    private readonly tmpCamLocal = new Vector3();
    private readonly tmpRefLocal = new Vector3();
    private readonly tmpCamDelta = new Vector3();
    private readonly tmpNormal = new Vector3();
    private readonly tmpLightLocal = new Vector3();
    /** 6 frustum planes packed as (nx,ny,nz,d) in camera-relative planet-local space. */
    private readonly frustumF32 = new Float32Array(24);
    /** 6 frustum plane normals (nx,ny,nz) in RENDER space, captured at the last re-bake. Under floating
     *  origin the camera sits at the render origin, so these depend on camera ORIENTATION + fov only
     *  (not position) — comparing the live frustum against them detects mouse-look, which neither the
     *  position drift nor the planet-spin signal catches (so the cull used to freeze when looking around
     *  from a stationary camera). */
    private readonly anchorViewNormals = new Float32Array(18);
    /** Anti-pop guard band, in leaf-edge multiples (off-screen kept fine within this band). */
    private static readonly FRUSTUM_GUARD = 1.5;
    /** forcedInstanceCount = min(capacity, liveCount*SAFETY + FLOOR) — absorbs readback lag. */
    private static readonly INSTANCE_SAFETY = 2;
    private static readonly INSTANCE_FLOOR = 8192;
    /** Cosine of the max planet rotation (since the anchor) tolerated before re-baking (~0.3deg). */
    private static readonly ROT_EPS_COS = Math.cos((0.3 * Math.PI) / 180);
    /** A single-frame jump above this MANY drift thresholds is a teleport/discontinuity → arm the
     *  convergence burst. Screen-relative (not absolute km): a distant fast-spinning planet's large
     *  planet-local per-frame drift is sub-pixel, so it must NOT be mistaken for a teleport (that
     *  armed a perpetual burst under GPU load → frames slow → bigger jump → re-arm: a feedback loop). */
    private static readonly JUMP_FACTOR = 8;
    /** Fixed world reference axis transformed into planet-local to measure planet spin (see anchorRefLocal). */
    private static readonly WORLD_REF = new Vector3(1, 0, 0);
    /** Frames to keep refining AFTER a discrete jump, so the concurrent topology (bounded work/frame)
     *  fully converges for the new view before its passes are skipped. Reused as the burst length. */
    private static readonly SETTLE_FRAMES = 90;
    /** Default df64->f32 noise cutoff (km) for the eval. Aggressive: df64 only within ~2 km of the
     *  camera (where f32 dir quantization would band the relief); f32 beyond. Live-tunable via
     *  globalThis.__terrainDf64NearKm. Raise it if banding appears very close to the ground. */
    private static readonly DF64_NEAR_KM_DEFAULT = 2.0;
    /** Axe 3: re-bake the heavy TERRAIN pipeline only 1 frame in N under steady drift (the draw stays
     *  exact between via uCamDelta). 1 = every frame (old behavior). Live-tunable via
     *  globalThis.__terrainRebakeEvery. Higher = cheaper motion, slightly more LOD latency. */
    private static readonly REBAKE_EVERY_DEFAULT = 3;
    /** OPT-4 adaptive throttle ramp (frames of sustained steady drift). After RAMP1 the re-bake interval
     *  doubles (base->2x), after RAMP2 it triples (base->3x). ~0.5 s / ~1.5 s at 60 fps. */
    private static readonly ADAPT_RAMP1 = 30;
    private static readonly ADAPT_RAMP2 = 90;
    /** Warn once when the live leaf count (pool_tree[1]) crosses this fraction of the pool: beyond it
     *  the Allocate pass starts dropping splits → the limb silently under-tessellates. */
    private static readonly POOL_SATURATION_FRAC = 0.9;

    private readonly key: string;
    private ready = false;
    private disposed = false;
    private liveLeafCount = 0;
    private poolSaturationWarned = false;
    private statsReadPending = false;
    private wantWireframe = false;
    private wantDebugLod = false;

    constructor(
        engine: WebGPUEngine,
        scene: Scene,
        opts: TerrainSourceOptions,
        listener: TerrainGeometryListener
    ) {
        this.listener = listener;
        this.key = opts.key;
        this.starPos = opts.starPosWorldDouble;
        this.starIntensity = opts.starIntensity;
        this.radius = opts.radiusSim;
        this.splitThresholdPx = opts.splitThresholdPx;
        this.mergeThresholdPx = opts.mergeThresholdPx;
        this.cullMinDot = opts.cullMinDot ?? -0.1;
        this.maxLevel = opts.maxLevel;
        this.minLevel = opts.minLevel;
        this.heightMargin = Math.max(0, opts.noise.globalAmplitude);

        // useIndirect: the 7 work-list passes dispatch over their candidate counts
        // (not the full pool) via PrepareIndirect + dispatchIndirect. noise: the df64 eval
        // bakes it so the decoded positions are TERRAIN-displaced (terrain-aware topology).
        const craters = opts.craters ?? DEFAULT_CRATERS;
        this.kernel = new TerrainTopologyKernel(engine, opts.capacity, 'metric', true, opts.noise, craters);

        this.render = buildTerrainRenderMaterial(
            scene,
            opts.key,
            {
                radius: opts.radiusSim,
                noise: opts.noise,
                craters,
                lightColor: opts.starColor,
                albedo: opts.lighting
                    ? new Vector3(opts.lighting.albedo[0], opts.lighting.albedo[1], opts.lighting.albedo[2])
                    : undefined,
                ambient: opts.lighting
                    ? new Vector3(opts.lighting.ambient[0], opts.lighting.ambient[1], opts.lighting.ambient[2])
                    : undefined,
                atmoDensity: opts.lighting?.atmoDensity,
                atmoColor: opts.lighting
                    ? new Vector3(opts.lighting.atmoColor[0], opts.lighting.atmoColor[1], opts.lighting.atmoColor[2])
                    : undefined,
                lighting: opts.lighting
            },
            this.kernel.heapBuffer,
            this.kernel.positionsBuffer,
            this.kernel.indicesBuffer
        );

        this.mesh = createTerrainTemplateMesh(scene, opts.key);
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
                this.kernel.runCompact(); // build the seed's draw-index list, arms evalLebActive
                this.kernel.runEvalLeb(); // decode the seed corners via active-list dispatch
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
                console.error('[TerrainSource] kernel init failed', e);
            });
    }

    refresh(): void {
        // Tree is seeded + the mesh built once the kernel is ready; the per-frame
        // update refines it. Nothing to emit on the main thread.
    }

    /**
     * Altitude-adaptive horizon cull threshold (replaces a fixed cullMinDot). A leaf is
     * over the planet limb (occluded) when its centroid direction d satisfies
     * dot(d, camDir) < cos(theta), where theta is the angular radius of what the camera can
     * possibly see. Relief-aware so it never culls a visible peak:
     *   theta = acos((R-A)/r_cam)   // camera's horizon over the LOWEST possible limb (R-A)
     *         + acos((R-A)/(R+A))   // extra reach: a MAX peak (R+A) seen over that limb
     * At 1 km altitude this keeps a ~17 deg cap instead of the old ~96 deg (cullMinDot -0.1),
     * so the pool stops refining occluded over-horizon terrain. A is the max radial relief.
     * At high altitude theta -> ~90 deg+, so it relaxes to (more than) a hemisphere.
     */
    private horizonCullMinDot(): number {
        const R = this.radius;
        const A = Math.min(this.heightMargin, R * 0.5); // clamp pathological relief
        const rCam = Math.max(this.tmpCamLocal.length(), R - A + 1e-3);
        const rLow = Math.max(1, R - A);
        const camTerm = Math.acos(Math.min(1, rLow / rCam));
        const peakTerm = Math.acos(Math.min(1, rLow / (R + A)));
        // Small extra guard so leaves right at the limb are not popped.
        const theta = Math.min(Math.PI, camTerm + peakTerm + 0.05);
        // Never let the dynamic value be LESS aggressive than the configured floor.
        return Math.max(this.cullMinDot, Math.cos(theta));
    }

    requestUpdate(frame: TerrainFrameParams): void {
        if (this.disposed || !this.ready) return;

        // Camera in planet-local space = R^-1 * (camera.doublepos - entity.doublepos).
        // The camera sits at the render origin under floating origin, so naively this is
        // inverse(renderParentWorld) * (0,0,0,1) — but that reads the f32 matrix 4th column
        // (renderParent.position ≈ -R ≈ -1,737 sim units), whose ULP at planet-radius scale
        // is ~20 cm. When the camera drifts slowly near ground, that value oscillates across
        // f32 boundaries every frame → uCamDelta jitters by ~20 cm → visible left-right shimmer
        // AND spurious rebakes (the 20 cm jump exceeds the ~19 cm driftThreshKm at ground level).
        // Fix: use f64 arithmetic for the translation offset; only the rotation (3x3, values ≤ 1)
        // needs the f32 matrix. TransformNormal ignores the 4th column — same technique as
        // resolveGroundCollision, which already handles this correctly.
        {
            const ep = frame.planetCenterWorldDouble;
            const dp = frame.cameraWorldDouble;
            this.tmpCamLocal.set(dp.x - ep.x, dp.y - ep.y, dp.z - ep.z);
            frame.renderParentWorldMatrix.invertToRef(this.tmpInv);
            Vector3.TransformNormalToRef(this.tmpCamLocal, this.tmpInv, this.tmpCamLocal);
        }
        const focalPx = frame.viewportHeightPx / (2 * Math.tan(frame.cameraFovRadians * 0.5));

        // --- Re-bake-on-drift gate -----------------------------------------------------------
        // The topology + EvaluateLEB + compact passes are ~33 GPU compute passes/frame, dominated by
        // the df64 fbm noise in EvaluateLEB. The OLD gate skipped them when the camera was unmoved in
        // PLANET-LOCAL space — but a spinning planet (or numerical jitter at interplanetary origins)
        // moves the camera in planet-local EVERY frame, so it never disengaged at ground (GPU 100%).
        //
        // Instead: bake POSITIONS against a FROZEN anchor and carry the per-frame residual
        // (anchorCamLocal - liveCamLocal) in the render uniform uCamDelta, which keeps the draw EXACT
        // between re-bakes (vertex: R*(localRel+uCamDelta); fragment: camDistKm = |rel+uCamDelta|).
        // Re-bake only when the drift would actually matter: lateral drift past the prefetch guard
        // band, planet spin past ROT_EPS, f32 precision cap, a LOD-changing/discrete jump, or the
        // first frame. A still camera on a (slowly) spinning planet now re-bakes rarely → ~0 passes.

        // Planet spin reference: a fixed world axis in planet-local; its rotation away from the anchor
        // value measures spin since the anchor (catches spin near the axis, where camLocal barely moves).
        Vector3.TransformNormalToRef(TerrainSource.WORLD_REF, this.tmpInv, this.tmpRefLocal);

        // Residual drift since the frozen anchor (tmpCamDelta = anchor - live).
        let driftKm = Infinity;
        let viewRotated = true;
        if (this.anchorValid) {
            this.anchorCamLocal.subtractToRef(this.tmpCamLocal, this.tmpCamDelta);
            driftKm = this.tmpCamDelta.length();
            viewRotated =
                Vector3.Dot(this.anchorRefLocal, this.tmpRefLocal) < TerrainSource.ROT_EPS_COS;
        } else {
            this.tmpCamDelta.set(0, 0, 0);
        }

        // Camera ORIENTATION (mouse-look) change since the anchor. Under floating origin the camera is
        // at the render origin, so the render-space frustum normals depend on view orientation + fov
        // only (position-independent). This is the signal the drift + planet-spin gate was MISSING:
        // without it, looking around from a PARKED camera never re-baked, so the frustum cull and the
        // prefetch froze ("camera at rest, culling stops"). Translation is still caught by driftKm.
        let viewDirChanged = false;
        const fp = frame.frustumPlanes;
        if (this.anchorValid && fp && fp.length >= 6) {
            let minDot = 1;
            for (let i = 0; i < 6; i++) {
                const n = fp[i].normal;
                const d =
                    n.x * this.anchorViewNormals[i * 3] +
                    n.y * this.anchorViewNormals[i * 3 + 1] +
                    n.z * this.anchorViewNormals[i * 3 + 2];
                if (d < minDot) minDot = d;
            }
            viewDirChanged = minDot < TerrainSource.ROT_EPS_COS;
        }

        // LOD-aware coverage threshold: the finest visible leaf edge projects to ~splitThresholdPx, so
        // its world size ~ splitThresholdPx*altitude/focalPx. Re-bake before lateral drift crosses half
        // the prefetch guard band. This is SCREEN-projected, so a near-ground planet gets a tight (m)
        // threshold while a distant one (e.g. Earth seen from the Moon, spinning fast off-axis → big
        // planet-local drift but sub-pixel on screen) gets a huge (km) threshold and stays frozen.
        // No flat absolute cap: it would force distant fast-spinning planets to re-bake every frame.
        const altKm = Math.max(this.tmpCamLocal.length() - this.radius, 1e-3);
        const finestLeafKm = (this.splitThresholdPx * altKm) / Math.max(focalPx, 1);
        const driftThreshKm = 0.5 * TerrainSource.FRUSTUM_GUARD * finestLeafKm;

        // Discrete jump (teleport / fast fly) → arm a convergence burst (incremental topology needs
        // ~SETTLE_FRAMES to fully refine a new view). Steady drift/spin needs only single re-bakes.
        // The jump bar is SCREEN-relative (× driftThreshKm) so a distant planet's large but sub-pixel
        // per-frame spin drift is NOT mistaken for a teleport (which would arm a self-sustaining burst).
        const jump = isFinite(this.lastFrameCamLocal.x)
            ? Vector3.Distance(this.tmpCamLocal, this.lastFrameCamLocal)
            : Infinity;
        this.lastFrameCamLocal.copyFrom(this.tmpCamLocal);
        if (!this.anchorValid || jump > TerrainSource.JUMP_FACTOR * driftThreshKm) {
            this.convergeFrames = TerrainSource.SETTLE_FRAMES;
        }

        // Axe 3 — throttle the heavy re-bake. The full pipeline (topology classify/copy/reduce over
        // the 1M pool + split/merge + eval + compact) costs ~31 ms/frame at ground and, profiled,
        // DOMINATES the moving-ground GPU cost (the per-pixel fragment is cheap — 60 fps when still
        // even at 5 MP supersampling). Since the DRAW stays exact between re-bakes (uCamDelta carries
        // the translation, the world matrix R the rotation), we only need fresh POSITIONS for the
        // classify METRIC, which tolerates a few frames of lag. So under steady drift/spin we re-bake
        // only 1 frame in REBAKE_EVERY; the skipped frames just draw (cheap). Convergence bursts and
        // the first bake always re-bake every frame (they must converge fast). Live-tunable.
        const baseRebakeEvery = Math.max(
            1,
            Math.floor(
                (globalThis as unknown as { __terrainRebakeEvery?: number }).__terrainRebakeEvery ??
                TerrainSource.REBAKE_EVERY_DEFAULT
            )
        );
        const forcedRebake = !this.anchorValid || this.convergeFrames > 0;
        const rotating = viewRotated || viewDirChanged;
        const driftDriven = driftKm > driftThreshKm || rotating;
        this.framesSinceRebake++;

        // OPT-4: adaptive re-bake throttle. Under STEADY translation-only drift (converged, no rotation,
        // no jump) the classify metric tolerates more lag, so stretch the interval base->2x->3x to further
        // amortize the heavy topology/eval passes. ANY rotation, jump, or convergence burst snaps it back
        // to the base interval the SAME frame, so the frustum cull + prefetch stay responsive (a throttled
        // cull during mouse-look pops leaves in — the failure mode the profiling bilan flagged). The draw
        // is exact between re-bakes either way (uCamDelta), so this only adds a little LOD-metric latency
        // to slow steady motion — never a visual change. Disable via globalThis.__terrainAdaptiveRebake=false.
        if (rotating || forcedRebake) {
            this.steadyDriftFrames = 0;
        } else {
            this.steadyDriftFrames++;
        }
        const adaptiveOn =
            (globalThis as unknown as { __terrainAdaptiveRebake?: boolean }).__terrainAdaptiveRebake ??
            true;
        let rebakeEvery = baseRebakeEvery;
        if (adaptiveOn && !rotating && !forcedRebake) {
            if (this.steadyDriftFrames > TerrainSource.ADAPT_RAMP2) {
                rebakeEvery = baseRebakeEvery * 3;
            } else if (this.steadyDriftFrames > TerrainSource.ADAPT_RAMP1) {
                rebakeEvery = baseRebakeEvery * 2;
            }
        }
        // Bench/profiling override: pin the topology (skip ALL rebakes) so a fragment perf-mask A/B
        // sweep runs at a CONSTANT leaf count — the clean way to attribute per-block fragment cost
        // (the old in-flight sweep was confounded by leaf-count variance). PRECONDITION: converge the
        // view FIRST (this hard-freezes even the forced/burst rebake), then set the flag. The draw stays
        // exact between frames (uCamDelta keeps carrying the residual) and setPerfMask below still
        // applies each frame, so toggling blocks takes effect while the leaf set is held.
        const freezeTopology = !!(
            globalThis as unknown as { __terrainFreezeTopology?: boolean | number }
        ).__terrainFreezeTopology;
        const needRebake =
            !freezeTopology &&
            (forcedRebake || (driftDriven && this.framesSinceRebake >= rebakeEvery));

        // uCamDelta carries the residual so the draw is exact between re-bakes (0 on a re-bake frame).
        if (needRebake) this.tmpCamDelta.set(0, 0, 0);
        this.render.setCamDelta(this.tmpCamDelta);

        // Debug fragment perf-profiling mask (set via __world42Perf.setPerfMask): bit0 skip slope
        // normal, bit1 skip df64 ground detail, bit2 skip crater rays — to A/B each block's GPU cost.
        // Set every frame (even when the topology is frozen) so toggles take effect immediately.
        this.render.setPerfMask(
            (globalThis as unknown as { __terrainPerfMask?: number }).__terrainPerfMask ?? 0
        );
        this.render.setLightIntensity(this.starIntensity);

        if (needRebake) {
            this.kernel.setCameraParams({
                camLocal: [this.tmpCamLocal.x, this.tmpCamLocal.y, this.tmpCamLocal.z],
                radius: this.radius,
                focalPx,
                splitThresholdPx: this.splitThresholdPx,
                mergeThresholdPx: this.mergeThresholdPx,
                cullMinDot: this.horizonCullMinDot(),
                maxLevel: this.maxLevel,
                minLevel: this.minLevel,
                // df64->f32 noise cutoff (km), live-tunable via the global. Beyond it the eval uses the
                // cheaper f32 noise twin (exact past the threshold — banding only shows very close).
                df64NearKm:
                    (globalThis as unknown as { __terrainDf64NearKm?: number }).__terrainDf64NearKm ??
                    TerrainSource.DF64_NEAR_KM_DEFAULT
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
                    // Anchor the RENDER-space normal for next frame's mouse-look detection.
                    this.anchorViewNormals[i * 3 + 0] = pl.normal.x;
                    this.anchorViewNormals[i * 3 + 1] = pl.normal.y;
                    this.anchorViewNormals[i * 3 + 2] = pl.normal.z;
                }
                // heightMargin = 0: positions are terrain-displaced now, so the frustum is exact.
                this.kernel.setFrustum(this.frustumF32, TerrainSource.FRUSTUM_GUARD, true, 0);
            } else {
                this.kernel.setFrustum(this.frustumF32, TerrainSource.FRUSTUM_GUARD, false, 0);
            }

            // Alternate split (even) / merge (odd) RE-BAKES so the two halves never race on the
            // same neighbor buffer. The split/merge limit cycle that used to flicker the mesh is
            // broken in PrepareSimplify (conformity guard: a leaf with a finer neighbor is not
            // merged, so the split pass can't re-create it).
            if ((this.frame++ & 1) === 0) {
                this.kernel.runFrame();
            } else {
                this.kernel.runMergeFrame();
            }
            // Compact first: builds the current-frame active list so evalLebActive can
            // dispatch O(alive) over exactly the right slots (no stale-list gap).
            this.kernel.runCompact();
            // Decode the live slots to vertex corners for this frame's draw (and next
            // frame's classify, which reads the positions buffer).
            this.kernel.runEvalLeb();

            // Re-anchor: POSITIONS is now baked against the live camera. uCamAnchor MUST be the same
            // f32 camLocal the df64 eval subtracted (world = uCamAnchor + rel cancels its rounding).
            this.anchorCamLocal.copyFrom(this.tmpCamLocal);
            this.anchorRefLocal.copyFrom(this.tmpRefLocal);
            this.anchorValid = true;
            this.render.setCamAnchor(this.tmpCamLocal);
            this.framesSinceRebake = 0;
            if (this.convergeFrames > 0) this.convergeFrames--;
        }

        // lightDirection convention: planetCenter - starPos (star→planet), shader negates to get L toward star.
        if (this.starPos) {
            this.tmpDir.copyFrom(frame.planetCenterWorldDouble).subtractInPlace(this.starPos);
            if (this.tmpDir.lengthSquared() > 1e-12) {
                this.tmpDir.normalize();
                // Transform to planet-local so it matches the FBM normals (TransformNormal
                // ignores translation — no-op without rotation, correct when rotation is wired).
                Vector3.TransformNormalToRef(this.tmpDir, this.tmpInv, this.tmpLightLocal);
                this.render.setLightDirection(this.tmpLightLocal);
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
                    // Pool-saturation guard (pool_tree[1] vs capacity): if the live leaf set ever
                    // approaches the fixed pool, the Allocate pass starts dropping splits and the limb
                    // silently under-tessellates. Warn ONCE so a too-small TERRAIN_CAPACITY (or a planet
                    // that needs more than Dev/Moon's ~401k) is visible, not mistaken for a LOD bug.
                    if (
                        !this.poolSaturationWarned &&
                        count > TerrainSource.POOL_SATURATION_FRAC * this.kernel.capacity
                    ) {
                        this.poolSaturationWarned = true;
                        console.warn(
                            `[TERRAIN] ${this.key}: live leaves ${count} > ` +
                            `${Math.round(TerrainSource.POOL_SATURATION_FRAC * 100)}% of pool ` +
                            `${this.kernel.capacity} — raise TERRAIN_CAPACITY (limb may under-tessellate).`
                        );
                    }
                    // Bound the draw to the live count (= compaction count = pool_tree[1]),
                    // over-estimated to absorb readback latency + growth. Jump UP instantly,
                    // ramp DOWN slowly so a single stale-small read can't pop holes.
                    const want = Math.min(
                        this.kernel.capacity,
                        Math.ceil(count * TerrainSource.INSTANCE_SAFETY) + TerrainSource.INSTANCE_FLOOR
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
        // Invalidate the re-bake anchor so the next frame forces a full topology + EvaluateLEB pass
        // (and a convergence burst). Without this, a teleport would bake the new view against a stale
        // anchor with a huge uCamDelta. The GPU engine re-derives all geometry from there.
        this.anchorValid = false;
        this.convergeFrames = TerrainSource.SETTLE_FRAMES;
    }

    /**
     * Enable/disable the mesh draw. The TERRAIN template mesh has alwaysSelectAsActiveMesh = true
     * (procedural bounds → Babylon never frustum-culls it), so an off-screen planet keeps
     * drawing its full leaf set every frame. The scheduler calls this from its render-space
     * frustum test to stop the draw of a planet the camera is not looking at (e.g. Earth while
     * standing on the Moon). Disabling does NOT touch the topology/positions buffers, so the
     * last-converged tree is still there when the planet re-enters the frustum.
     */
    setVisible(on: boolean): void {
        this.mesh.setEnabled(on);
    }

    /** TERRAIN compute GPU timings (ms, last-second average) for the perf HUD. Delegates to the kernel. */
    getGpuTimings(): { topoMs: number; evalMs: number; compactMs: number } {
        return this.kernel.getGpuTimings();
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
