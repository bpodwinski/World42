import type { Engine, Scene, WebGPUEngine } from "@babylonjs/core";
import { DirectionalLight, Matrix, ShadowGenerator, Vector2, Vector3 } from "@babylonjs/core";
import { TerrainShader, TerrainShadowContext } from "./terrains_shader";
import { PlanetCDLOD } from "../../../game_world/stellar_system/stellar_catalog_loader";
import { OriginCamera } from "../../../core/camera/camera_manager";

export type TerrainShadowSystemOptions = {
    shadowMapSize?: number;

    minShadowRange?: number;
    maxShadowRange?: number;
    rangeLerp?: number;

    depthHalfMult?: number;
    lightDistMult?: number;
    lightDistAdd?: number;

    pickIntervalMs?: number;

    // Bias ShadowGenerator
    generatorBias?: number;
    generatorNormalBias?: number;

    // Bias shader (peter-panning)
    shaderBias?: number;
    darkness?: number;
};

export class TerrainShadowSystem {
    private opts: Required<TerrainShadowSystemOptions>;

    private shadowLight: DirectionalLight;
    private shadowGen: ShadowGenerator;
    private shadowCtx: TerrainShadowContext;

    private shadowRange = 12000;

    private activePlanet: PlanetCDLOD | null = null;
    private lastPickMs = 0;

    private beforeRenderObs: any | null = null;

    // temporaires (évite alloc)
    private tmpStarRender = new Vector3();
    private tmpPlanetRender = new Vector3();
    private lightDirRender = new Vector3();
    private camPosRender = new Vector3();
    private lightRight = new Vector3();
    private lightUp = new Vector3();
    private lightView = new Matrix();
    private centerLS = new Vector3();
    private tmpTarget = new Vector3();

    constructor(
        private args: {
            scene: Scene;
            engine: Engine | WebGPUEngine;
            camera: OriginCamera;

            // planets peut être Map ou Array/Iterable
            planets: Iterable<PlanetCDLOD>;
        },
        options: TerrainShadowSystemOptions = {}
    ) {
        this.opts = {
            shadowMapSize: options.shadowMapSize ?? 4096,

            minShadowRange: options.minShadowRange ?? 6000,
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

        // DirectionalLight (Render-space)
        this.shadowLight = new DirectionalLight("terrainShadowLight", new Vector3(0, -1, 0), scene);
        this.shadowLight.intensity = 0;

        // ShadowGenerator (shared)
        this.shadowGen = new ShadowGenerator(this.opts.shadowMapSize, this.shadowLight, true);
        this.shadowGen.bias = this.opts.generatorBias;
        this.shadowGen.normalBias = this.opts.generatorNormalBias;

        const reverseDepth = (this.args.engine as any).useReverseDepthBuffer ? 1 : 0;

        // Contexte partagé lu côté shader
        this.shadowCtx = {
            shadowGen: this.shadowGen,
            shadowMap: this.shadowGen.getShadowMapForRendering()!, // IMPORTANT WebGPU
            lightMatrix: new Matrix(),
            texelSize: new Vector2(1 / this.opts.shadowMapSize, 1 / this.opts.shadowMapSize),
            bias: this.opts.shaderBias,
            darkness: this.opts.darkness,
            reverseDepth,
        };

        TerrainShader.setTerrainShadowContext(scene, this.shadowCtx);

        this.pickActivePlanetNow(); // init
    }

    public attach(): () => void {
        const { scene } = this.args;

        this.beforeRenderObs = scene.onBeforeRenderObservable.add(() => this.tick());

        return () => {
            if (this.beforeRenderObs) {
                scene.onBeforeRenderObservable.remove(this.beforeRenderObs);
                this.beforeRenderObs = null;
            }

            // Dispose GPU resources
            this.shadowGen.dispose();
            this.shadowLight.dispose();

            // Optionnel: si tu as un unset dans TerrainShader, tu peux le faire ici.
            // TerrainShader.setTerrainShadowContext(scene, null as any);

            this.activePlanet = null;
        };
    }

    /** À appeler après un teleport pour ne pas attendre le throttle. */
    public forcePickNow(): void {
        this.lastPickMs = 0;
        this.pickActivePlanetNow();
    }

    private planetsIterable(): Iterable<PlanetCDLOD> {
        // support Map ou array/iterable
        const p: any = this.args.planets as any;
        return typeof p?.values === "function" ? p.values() : p;
    }

    // --- Repère: WorldDouble (camera.doublepos / planet.doublepos / starPosWorldDouble)
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

    private tick(): void {
        const { camera } = this.args;
        const now = performance.now();

        // (A) choisir planète active (throttle)
        if (now - this.lastPickMs > this.opts.pickIntervalMs) {
            this.pickActivePlanetNow();
            this.lastPickMs = now;
        }
        if (!this.activePlanet) return;

        const starPosWorldDouble = this.activePlanet.chunks[0]?.starPosWorldDouble;
        if (!starPosWorldDouble) return;

        // (B) Conversion WorldDouble -> Render (floating origin)
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

        // (C) Direction rayons: étoile -> planète (Render)
        this.lightDirRender.copyFrom(this.tmpPlanetRender).subtractInPlace(this.tmpStarRender);
        if (this.lightDirRender.lengthSquared() < 1e-12) return;
        this.lightDirRender.normalize();
        this.shadowLight.direction.copyFrom(this.lightDirRender);

        // (D) Centre autour caméra (Render)
        this.camPosRender.copyFrom(camera.position);

        // (E) shadowRange dynamique (altitude -> range) — (WorldDouble)
        const distToCenterSim = camera.distanceToSim(planetCenterWD);
        const altitudeSim = Math.max(0, distToCenterSim - this.activePlanet.radius);

        const targetRange = Math.min(
            this.opts.maxShadowRange,
            Math.max(this.opts.minShadowRange, altitudeSim * 2.0 + 2000.0)
        );

        // Quantize pour éviter le pumping
        const targetQ = this.quantizeRange(targetRange);
        this.shadowRange += (targetQ - this.shadowRange) * this.opts.rangeLerp;

        const lightDistance = this.shadowRange * this.opts.lightDistMult + this.opts.lightDistAdd;

        // (F) Ortho autour caméra (Render)
        this.shadowLight.orthoLeft = -this.shadowRange;
        this.shadowLight.orthoRight = this.shadowRange;
        this.shadowLight.orthoTop = this.shadowRange;
        this.shadowLight.orthoBottom = -this.shadowRange;

        // (G) Profondeur serrée (Render)
        const depthHalf = this.shadowRange * this.opts.depthHalfMult;
        this.shadowLight.shadowMinZ = Math.max(0.1, lightDistance - depthHalf);
        this.shadowLight.shadowMaxZ = lightDistance + depthHalf;

        // (H) Position light autour caméra (Render)
        this.shadowLight.position.copyFrom(this.camPosRender).subtractInPlace(
            this.lightDirRender.scale(lightDistance)
        );

        // (I) Snap stable (réduit shimmer)
        const worldUnitsPerTexel = (2.0 * this.shadowRange) / this.opts.shadowMapSize;

        Matrix.LookAtLHToRef(
            this.shadowLight.position,
            this.shadowLight.position.add(this.shadowLight.direction),
            Vector3.Up(),
            this.lightView
        );

        Vector3.TransformCoordinatesToRef(this.camPosRender, this.lightView, this.centerLS);

        const snappedX = Math.round(this.centerLS.x / worldUnitsPerTexel) * worldUnitsPerTexel;
        const snappedY = Math.round(this.centerLS.y / worldUnitsPerTexel) * worldUnitsPerTexel;

        const dx = this.centerLS.x - snappedX;
        const dy = this.centerLS.y - snappedY;

        const upRef =
            Math.abs(Vector3.Dot(this.lightDirRender, Vector3.Up())) > 0.98
                ? Vector3.Forward()
                : Vector3.Up();

        Vector3.CrossToRef(upRef, this.lightDirRender, this.lightRight);
        this.lightRight.normalize();

        Vector3.CrossToRef(this.lightDirRender, this.lightRight, this.lightUp);
        this.lightUp.normalize();

        this.shadowLight.position.addInPlace(this.lightRight.scale(dx));
        this.shadowLight.position.addInPlace(this.lightUp.scale(dy));

        // (J) lightMatrix finale
        this.shadowCtx.lightMatrix.copyFrom(this.shadowGen.getTransformMatrix());
    }

    private quantizeRange(r: number): number {
        const base = 2000;
        const q = base * Math.pow(2, Math.round(Math.log(r / base) / Math.log(2)));
        return Math.min(this.opts.maxShadowRange, Math.max(this.opts.minShadowRange, q));
    }
}
