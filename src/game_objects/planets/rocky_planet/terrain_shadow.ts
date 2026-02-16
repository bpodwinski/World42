import type { Engine, Scene, WebGPUEngine } from "@babylonjs/core";
import { DirectionalLight, Matrix, ShadowGenerator, Vector2, Vector3 } from "@babylonjs/core";
import { TerrainShader, TerrainShadowContext } from "./terrains_shader";
import { PlanetCDLOD } from "../../../game_world/stellar_system/stellar_catalog_loader";
import { OriginCamera } from "../../../core/camera/camera_manager";

/**
 * Options controlling the single-cascade directional shadow map used for terrain shading.
 *
 * Notes:
 * - This system renders a classic shadow map (one orthographic frustum) and samples it manually in the terrain shader.
 * - It is designed for a floating-origin world: CPU logic selects a planet using WorldDouble coordinates,
 *   then converts positions to Render-space for Babylon's shadow pipeline.
 */
export type TerrainShadowSystemOptions = {
    /** Shadow map resolution (width = height). Higher = sharper shadows but more GPU cost. */
    shadowMapSize?: number;

    /** Minimum orthographic half-size (world units) covered by the shadow camera. */
    minShadowRange?: number;
    /** Maximum orthographic half-size (world units) covered by the shadow camera. */
    maxShadowRange?: number;
    /** Exponential smoothing factor for shadowRange changes [0..1]. */
    rangeLerp?: number;

    /** Multiplier for orthographic depth range (min/max Z) relative to shadowRange. */
    depthHalfMult?: number;
    /** Multiplier for light distance from the camera relative to shadowRange. */
    lightDistMult?: number;
    /** Extra additive light distance offset (world units). */
    lightDistAdd?: number;

    /** How often we re-evaluate the "active" planet (ms). */
    pickIntervalMs?: number;

    // ShadowGenerator depth biases (hardware shadow map rendering)
    /** Depth bias applied inside Babylon's ShadowGenerator (helps acne). */
    generatorBias?: number;
    /** Normal bias applied inside Babylon's ShadowGenerator (helps acne on slopes). */
    generatorNormalBias?: number;

    // Shader-side bias (manual compare bias, can cause peter-panning if too large)
    /** Manual depth bias applied in the terrain shader compare step. */
    shaderBias?: number;
    /** Shadow darkness factor used by the terrain shader (1.0 = fully dark). */
    darkness?: number;
};

/**
 * TerrainShadowSystem
 *
 * Single shadow map (directional light + orthographic projection) tailored for a planet terrain.
 *
 * Coordinate spaces:
 * - WorldDouble: high-precision simulation coordinates (camera.doublepos / planet.entity.doublepos / starPosWorldDouble)
 * - Render-space: floating-origin coordinates used for Babylon rendering (camera.position near (0,0,0))
 *
 * Rule: never mix WorldDouble and Render-space in the same computation without explicit conversion.
 */
export class TerrainShadowSystem {
    /** Resolved options with defaults applied. */
    private opts: Required<TerrainShadowSystemOptions>;

    /** Directional light used only as a shadow camera (intensity = 0). */
    private shadowLight: DirectionalLight;
    /** Babylon shadow generator producing the shadow map (depth). */
    private shadowGen: ShadowGenerator;
    /** Shared context published to the terrain shader via scene metadata. */
    private shadowCtx: TerrainShadowContext;

    /** Current orthographic "budget" (used to derive far distance and light distance). */
    private shadowRange = 12000;

    /** Currently selected planet (nearest in WorldDouble). */
    private activePlanet: PlanetCDLOD | null = null;
    /** Throttle timestamp for planet picking. */
    private lastPickMs = 0;

    /** Handle to the scene onBeforeRender observer. */
    private beforeRenderObs: any | null = null;

    // --- Temporary objects (avoid allocations per-frame)
    private tmpStarRender = new Vector3();
    private tmpPlanetRender = new Vector3();
    private lightDirRender = new Vector3();
    private camPosRender = new Vector3();

    private lightView = new Matrix();
    private tmpInvView = new Matrix();

    private frustumCorners = Array.from({ length: 8 }, () => new Vector3());     // Render-space
    private frustumCornersVS = Array.from({ length: 8 }, () => new Vector3());   // View-space
    private tmpCornerLS = new Vector3();                                         // Light-space
    private tmpFrustumCenter = new Vector3();                                    // Render-space

    /**
     * @param args.scene Babylon scene
     * @param args.engine Babylon engine (WebGL or WebGPU)
     * @param args.camera OriginCamera (supports WorldDouble via camera.doublepos)
     * @param args.planets Iterable of PlanetCDLOD (can be a Map.values() iterator or any iterable)
     * @param options Optional settings to control shadow behavior
     */
    constructor(
        private args: {
            scene: Scene;
            engine: Engine | WebGPUEngine;
            camera: OriginCamera;

            /** Collection of planets (Map or Array/Iterable). */
            planets: Iterable<PlanetCDLOD>;
        },
        options: TerrainShadowSystemOptions = {}
    ) {
        this.opts = {
            shadowMapSize: options.shadowMapSize ?? 8192,

            minShadowRange: options.minShadowRange ?? 500,
            maxShadowRange: options.maxShadowRange ?? 50000,
            rangeLerp: options.rangeLerp ?? 0.12,

            depthHalfMult: options.depthHalfMult ?? 2.0,
            lightDistMult: options.lightDistMult ?? 2.5,
            lightDistAdd: options.lightDistAdd ?? 5000,

            pickIntervalMs: options.pickIntervalMs ?? 250,

            generatorBias: options.generatorBias ?? 0.0015,
            generatorNormalBias: options.generatorNormalBias ?? 0.6,

            shaderBias: options.shaderBias ?? 0.00025,
            darkness: options.darkness ?? 1.0,
        };

        const { scene } = this.args;

        // Create a DirectionalLight used exclusively for shadow mapping (no direct lighting).
        // IMPORTANT: this light operates in Render-space.
        this.shadowLight = new DirectionalLight("terrainShadowLight", new Vector3(0, -1, 0), scene);
        this.shadowLight.intensity = 0;

        // Create a shared ShadowGenerator (single shadow map).
        this.shadowGen = new ShadowGenerator(this.opts.shadowMapSize, this.shadowLight, true);
        this.shadowGen.bias = this.opts.generatorBias;
        this.shadowGen.normalBias = this.opts.generatorNormalBias;

        // Whether the engine uses a reverse depth buffer. The terrain shader needs to know.
        const reverseDepth = (this.args.engine as any).useReverseDepthBuffer ? 1 : 0;

        // Shared context read by the terrain shader.
        this.shadowCtx = {
            shadowGen: this.shadowGen,
            shadowMap: this.shadowGen.getShadowMapForRendering()!, // IMPORTANT for WebGPU
            lightMatrix: new Matrix(),
            texelSize: new Vector2(1 / this.opts.shadowMapSize, 1 / this.opts.shadowMapSize),
            bias: this.opts.shaderBias,
            darkness: this.opts.darkness,
            reverseDepth,
        };

        // Publish the context so each terrain chunk shader can bind it onRender/onBind.
        TerrainShader.setTerrainShadowContext(scene, this.shadowCtx);

        // Initial selection of the nearest planet (WorldDouble).
        this.pickActivePlanetNow();
    }

    /**
     * Attaches the system to the scene render loop and returns a disposer.
     *
     * @returns A function that detaches observers and disposes GPU resources.
     */
    public attach(): () => void {
        const { scene } = this.args;

        // Update shadow setup once per frame, before rendering.
        this.beforeRenderObs = scene.onBeforeRenderObservable.add(() => this.tick());

        return () => {
            if (this.beforeRenderObs) {
                scene.onBeforeRenderObservable.remove(this.beforeRenderObs);
                this.beforeRenderObs = null;
            }

            // Dispose GPU resources.
            this.shadowGen.dispose();
            this.shadowLight.dispose();

            this.activePlanet = null;
        };
    }

    /**
     * Forces immediate re-selection of the nearest planet.
     * Useful right after teleporting to avoid waiting for the pick throttle interval.
     */
    public forcePickNow(): void {
        this.lastPickMs = 0;
        this.pickActivePlanetNow();
    }

    /**
     * Returns a planet iterable, supporting both Map and generic iterable collections.
     */
    private planetsIterable(): Iterable<PlanetCDLOD> {
        const p: any = this.args.planets as any;
        return typeof p?.values === "function" ? p.values() : p;
    }

    /**
     * Select the nearest planet to the camera using high-precision WorldDouble distances.
     *
     * Coordinate space: WorldDouble (camera.doublepos / planet.entity.doublepos).
     */
    private pickActivePlanetNow(): void {
        const { camera } = this.args;

        let best: PlanetCDLOD | null = null;
        let bestD = Number.POSITIVE_INFINITY;

        for (const planet of this.planetsIterable()) {
            const d = camera.distanceToSim(planet.entity.doublepos);
            if (d < bestD) {
                bestD = d;
                best = planet;
            }
        }
        this.activePlanet = best;
    }

    /**
     * Per-frame update.
     *
     * Key improvement vs the old version:
     * - Instead of a fixed square ortho around the camera, we compute a *tight-fitting* orthographic projection
     *   around the camera view frustum slice [near..shadowFar]. This concentrates texels where they matter.
     */
    private tick(): void {
        const { camera, scene } = this.args;
        const now = performance.now();

        // (A) Pick active planet with throttle.
        if (now - this.lastPickMs > this.opts.pickIntervalMs) {
            this.pickActivePlanetNow();
            this.lastPickMs = now;
        }
        if (!this.activePlanet) return;

        // Star position must be available (WorldDouble) to compute the light direction.
        const starPosWorldDouble = this.activePlanet.chunks[0]?.starPosWorldDouble;
        if (!starPosWorldDouble) return;

        // (B) WorldDouble -> Render conversion (floating origin).
        const camWD = camera.doublepos;

        this.tmpStarRender.set(
            starPosWorldDouble.x - camWD.x,
            starPosWorldDouble.y - camWD.y,
            starPosWorldDouble.z - camWD.z
        );

        const planetCenterWD = this.activePlanet.entity.doublepos;
        this.tmpPlanetRender.set(
            planetCenterWD.x - camWD.x,
            planetCenterWD.y - camWD.y,
            planetCenterWD.z - camWD.z
        );

        // (C) Light direction: star -> planet (Render-space).
        this.lightDirRender.copyFrom(this.tmpPlanetRender).subtractInPlace(this.tmpStarRender);
        if (this.lightDirRender.lengthSquared() < 1e-12) return;
        this.lightDirRender.normalize();
        this.shadowLight.direction.copyFrom(this.lightDirRender);

        // (D) Camera render-space position.
        this.camPosRender.copyFrom(camera.position);

        // (E) Compute dynamic shadow "budget" from altitude (WorldDouble).
        const distToCenterSim = camera.distanceToSim(planetCenterWD);
        const altitudeSim = Math.max(0, distToCenterSim - this.activePlanet.radius);

        const targetRange = Math.min(
            this.opts.maxShadowRange,
            Math.max(this.opts.minShadowRange, altitudeSim + 250.0)
        );

        const targetQ = this.quantizeRange(targetRange);
        this.shadowRange += (targetQ - this.shadowRange) * this.opts.rangeLerp;

        // Light distance behind the frustum center along the light direction.
        const lightDistance = this.shadowRange * this.opts.lightDistMult + this.opts.lightDistAdd;

        // Active camera data for frustum build (Render-space matrices).
        const activeCam: any = scene.activeCamera ?? (camera as any);
        if (!activeCam?.getViewMatrix) return;

        const camNear = activeCam.minZ ?? 0.1;
        const shadowFar = Math.max(camNear + 1.0, this.shadowRange * 2.0);

        // (F) Tight-fit ortho: build frustum slice corners in Render-space.
        const corners = this.buildFrustumCornersRender(camNear, shadowFar);

        // Compute frustum center (Render-space).
        this.tmpFrustumCenter.set(0, 0, 0);
        for (let i = 0; i < 8; i++) this.tmpFrustumCenter.addInPlace(corners[i]);
        this.tmpFrustumCenter.scaleInPlace(1 / 8);

        // Choose a stable up reference when the light direction is near vertical.
        const upRef =
            Math.abs(Vector3.Dot(this.lightDirRender, Vector3.Up())) > 0.98 ? Vector3.Forward() : Vector3.Up();

        // Place the light so it looks at the frustum center.
        this.shadowLight.position.copyFrom(this.tmpFrustumCenter).subtractInPlace(
            this.lightDirRender.scale(lightDistance)
        );

        // Build light view matrix.
        Matrix.LookAtLHToRef(this.shadowLight.position, this.tmpFrustumCenter, upRef, this.lightView);

        // Fit ortho bounds by projecting frustum corners into light-space.
        let minX = Number.POSITIVE_INFINITY,
            maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY,
            maxY = Number.NEGATIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY,
            maxZ = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < 8; i++) {
            Vector3.TransformCoordinatesToRef(corners[i], this.lightView, this.tmpCornerLS);

            const x = this.tmpCornerLS.x;
            const y = this.tmpCornerLS.y;
            const z = this.tmpCornerLS.z;

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }

        // Small padding so casters slightly outside the frustum still contribute.
        const padXY = 8.0; // tune (2..20)
        minX -= padXY;
        maxX += padXY;
        minY -= padXY;
        maxY += padXY;

        // Expand depth range a bit (casters in front/behind the slice can matter).
        const zPad = (maxZ - minZ) * 0.2;
        minZ = Math.max(0.1, minZ - zPad);
        maxZ = maxZ + zPad;

        // (G) Texel-grid snapping by snapping bounds (reduces shimmering).
        const size = this.opts.shadowMapSize;
        const spanX = Math.max(1e-6, maxX - minX);
        const spanY = Math.max(1e-6, maxY - minY);

        const wptX = spanX / size;
        const wptY = spanY / size;

        minX = Math.floor(minX / wptX) * wptX;
        maxX = Math.ceil(maxX / wptX) * wptX;
        minY = Math.floor(minY / wptY) * wptY;
        maxY = Math.ceil(maxY / wptY) * wptY;

        // Apply fitted orthographic extents (Render-space light camera).
        this.shadowLight.orthoLeft = minX;
        this.shadowLight.orthoRight = maxX;
        this.shadowLight.orthoBottom = minY;
        this.shadowLight.orthoTop = maxY;

        // Apply fitted depth range (Render-space light camera).
        this.shadowLight.shadowMinZ = minZ;
        this.shadowLight.shadowMaxZ = maxZ;

        // (H) Update the final light view-projection matrix used by the terrain shader.
        this.shadowCtx.lightMatrix.copyFrom(this.shadowGen.getTransformMatrix());
    }

    /**
     * Quantize the shadow range to power-of-two steps.
     * This reduces visible "pumping" when the range is driven by altitude.
     *
     * @param r Target range (world units)
     * @returns Quantized range clamped to [minShadowRange..maxShadowRange]
     */
    private quantizeRange(r: number): number {
        const base = 1024;
        const q = base * Math.pow(2, Math.round(Math.log(r / base) / Math.log(2)));
        return Math.min(this.opts.maxShadowRange, Math.max(this.opts.minShadowRange, q));
    }

    /**
     * Builds the camera frustum corners in Render-space for a [near..far] slice.
     * Uses camera fov/aspect and view matrix inversion (stable vs NDC conventions).
     *
     * Coordinate spaces:
     * - Input near/far: view-space distances (Render pipeline)
     * - Output corners: Render-space coordinates
     */
    private buildFrustumCornersRender(near: number, far: number): Vector3[] {
        const { scene, engine, camera } = this.args;

        const activeCam: any = scene.activeCamera ?? (camera as any);

        const fov = activeCam.fov ?? Math.PI / 3;
        const aspect = engine.getAspectRatio(activeCam);

        const tan = Math.tan(fov * 0.5);

        const nh = near * tan;
        const nw = nh * aspect;
        const fh = far * tan;
        const fw = fh * aspect;

        // View-space corners (Babylon LH: +Z forward).
        this.frustumCornersVS[0].set(-nw, -nh, near);
        this.frustumCornersVS[1].set(nw, -nh, near);
        this.frustumCornersVS[2].set(nw, nh, near);
        this.frustumCornersVS[3].set(-nw, nh, near);

        this.frustumCornersVS[4].set(-fw, -fh, far);
        this.frustumCornersVS[5].set(fw, -fh, far);
        this.frustumCornersVS[6].set(fw, fh, far);
        this.frustumCornersVS[7].set(-fw, fh, far);

        // Invert view to go from view-space to Render-space.
        const view = activeCam.getViewMatrix();
        this.tmpInvView.copyFrom(view);
        this.tmpInvView.invert();

        for (let i = 0; i < 8; i++) {
            Vector3.TransformCoordinatesToRef(this.frustumCornersVS[i], this.tmpInvView, this.frustumCorners[i]);
        }

        return this.frustumCorners;
    }
}
