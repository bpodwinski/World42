import {
    DirectionalLight,
    Engine,
    Matrix,
    Scene,
    ShadowGenerator,
    Vector2,
    Vector3,
    WebGPUEngine,
} from '@babylonjs/core';
import { OriginCamera } from '../core/camera/camera_manager';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import { attachStarRayMarchingPostProcess, type StarGlowSource } from '../core/render/star_raymarch_postprocess';
import {
    createCBTForSystem,
    createCDLODForSystem,
    type LoadedSystem,
    type PlanetCBT,
    type PlanetCDLOD,
} from '../game_world/stellar_system/stellar_catalog_loader';
import { TerrainShader, type TerrainShadowContext } from '../game_objects/planets/rocky_planet/terrains_shader';
import { CbtScheduler } from '../systems/lod/cbt/cbt_scheduler';
import { LodScheduler } from '../systems/lod/lod_scheduler';

export type LodController = {
    resetNow: () => void;
};

export type LodSetupResult = {
    lod: LodController;
    refreshActivePlanetSelection: () => void;
};

type PlanetShadowSource = {
    entity: PlanetCDLOD['entity'] | PlanetCBT['entity'];
    radiusSim: number;
    starPosWorldDouble: Vector3 | null;
};

export function setupLodAndShadows(
    scene: Scene,
    engine: Engine | WebGPUEngine,
    camera: OriginCamera,
    loadedSystems: Map<string, LoadedSystem>,
    disposables: DisposableRegistry
): LodSetupResult {
    const mergedCDLOD = new Map<string, PlanetCDLOD>();
    const mergedCBT = new Map<string, PlanetCBT>();

    for (const system of loadedSystems.values()) {
        const cdlod = createCDLODForSystem(scene, camera, system, {
            maxLevel: 12,
            resolution: 96,
        });

        for (const [name, planet] of cdlod.entries()) {
            mergedCDLOD.set(`${system.systemId}:${name}`, planet);
        }

        const cbt = createCBTForSystem(scene, camera, system, {
            maxDepth: 16,
            minDepth: 0,
            maxSplitsPerFrame: 32,
            maxMergesPerFrame: 32,
            splitThresholdPx2: 900,
            splitHysteresis: 0.75,
        });

        for (const [name, planet] of cbt.entries()) {
            mergedCBT.set(`${system.systemId}:${name}`, planet);
        }
    }

    const roots = Array.from(mergedCDLOD.values()).flatMap((planet) => planet.chunks);
    const cdlodScheduler =
        roots.length > 0
            ? new LodScheduler(scene, camera, roots, {
                maxConcurrent: 8,
                maxStartsPerFrame: 2,
                rescoreMs: 100,
                applyDebugEveryFrame: true,
                budgetMs: 30,
            })
            : null;
    cdlodScheduler?.start();
    disposables.add(() => cdlodScheduler?.stop());

    const cbtPlanets = Array.from(mergedCBT.values()).map((planet) => planet.runtime);
    const cbtScheduler = new CbtScheduler(scene, camera, cbtPlanets, {
        budgetMs: 8,
    });
    cbtScheduler.start();
    disposables.add(() => cbtScheduler.dispose());

    const lod: LodController = {
        resetNow: () => {
            cdlodScheduler?.resetNow();
            cbtScheduler.resetNow();
        },
    };

    const mergedShadowPlanets = new Map<string, PlanetShadowSource>();
    for (const [key, planet] of mergedCDLOD.entries()) {
        mergedShadowPlanets.set(key, {
            entity: planet.entity,
            radiusSim: planet.radiusSim,
            starPosWorldDouble: planet.chunks[0]?.starPosWorldDouble ?? null,
        });
    }
    for (const [key, planet] of mergedCBT.entries()) {
        mergedShadowPlanets.set(key, {
            entity: planet.entity,
            radiusSim: planet.radiusSim,
            starPosWorldDouble: planet.starPosWorldDouble,
        });
    }

    const NEAR_SHADOW_MAP_SIZE = 4096;
    const FAR_SHADOW_MAP_SIZE = 4096;
    const MIN_NEAR_SHADOW_RANGE = 1800;
    const MAX_NEAR_SHADOW_RANGE = 18000;
    const MIN_FAR_SHADOW_RANGE = 9000;
    const MAX_FAR_SHADOW_RANGE = 80000;
    const RANGE_LERP = 0.18;
    const DEPTH_HALF_MULT = 2.0;
    const LIGHT_DIST_MULT = 2.25;
    const LIGHT_DIST_ADD = 3000;

    let nearShadowRange = 6000;
    let farShadowRange = 28000;

    const nearShadowLight = new DirectionalLight('terrainShadowLightNear', new Vector3(0, -1, 0), scene);
    nearShadowLight.intensity = 0;
    const nearShadowGen = new ShadowGenerator(NEAR_SHADOW_MAP_SIZE, nearShadowLight, true);
    nearShadowGen.bias = 0.0015;
    nearShadowGen.normalBias = 0.6;

    const farShadowLight = new DirectionalLight('terrainShadowLightFar', new Vector3(0, -1, 0), scene);
    farShadowLight.intensity = 0;
    const farShadowGen = new ShadowGenerator(FAR_SHADOW_MAP_SIZE, farShadowLight, true);
    farShadowGen.bias = 0.0015;
    farShadowGen.normalBias = 0.6;

    const nearShadowMap = nearShadowGen.getShadowMapForRendering();
    const farShadowMap = farShadowGen.getShadowMapForRendering();
    if (!nearShadowMap || !farShadowMap) {
        throw new Error('Shadow map is unavailable for terrain shadow context.');
    }

    const shadowCtx: TerrainShadowContext = {
        near: {
            shadowGen: nearShadowGen,
            shadowMap: nearShadowMap,
            lightMatrix: new Matrix(),
            texelSize: new Vector2(1 / NEAR_SHADOW_MAP_SIZE, 1 / NEAR_SHADOW_MAP_SIZE),
        },
        far: {
            shadowGen: farShadowGen,
            shadowMap: farShadowMap,
            lightMatrix: new Matrix(),
            texelSize: new Vector2(1 / FAR_SHADOW_MAP_SIZE, 1 / FAR_SHADOW_MAP_SIZE),
        },
        bias: 0.00025,
        normalBias: 0.002,
        darkness: 1,
        reverseDepth: engine.useReverseDepthBuffer ? 1 : 0,
        blendStart: nearShadowRange * 0.9,
        blendEnd: nearShadowRange * 1.6,
    };
    TerrainShader.setTerrainShadowContext(scene, shadowCtx);
    disposables.add(() => TerrainShader.setTerrainShadowContext(scene, null));

    let activePlanet: PlanetShadowSource | null = null;
    let lastPickMs = 0;
    const PICK_MS = 250;

    function pickActivePlanetNow(): void {
        let best: PlanetShadowSource | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const planet of mergedShadowPlanets.values()) {
            const distance = camera.distanceToSim(planet.entity.doublepos);
            if (distance < bestDistance) {
                best = planet;
                bestDistance = distance;
            }
        }
        activePlanet = best;
    }
    pickActivePlanetNow();

    function clampRange(range: number, min: number, max: number): number {
        return Math.min(max, Math.max(min, range));
    }

    const tmpStarRender = new Vector3();
    const tmpPlanetRender = new Vector3();
    const lightDir = new Vector3();
    const camPosRender = new Vector3();
    const lightRight = new Vector3();
    const lightUp = new Vector3();
    const lightView = new Matrix();
    const centerLS = new Vector3();
    const tmpLightTarget = new Vector3();

    function configureShadowCascade(
        light: DirectionalLight,
        range: number,
        mapSize: number
    ): void {
        const lightDistance = range * LIGHT_DIST_MULT + LIGHT_DIST_ADD;

        light.orthoLeft = -range;
        light.orthoRight = range;
        light.orthoTop = range;
        light.orthoBottom = -range;

        const depthHalf = range * DEPTH_HALF_MULT;
        light.shadowMinZ = Math.max(0.1, lightDistance - depthHalf);
        light.shadowMaxZ = lightDistance + depthHalf;
        light.position.copyFrom(camPosRender).subtractInPlace(lightDir.scale(lightDistance));

        const worldUnitsPerTexel = (2 * range) / mapSize;
        tmpLightTarget.copyFrom(light.position).addInPlace(light.direction);
        Matrix.LookAtLHToRef(light.position, tmpLightTarget, Vector3.Up(), lightView);
        Vector3.TransformCoordinatesToRef(camPosRender, lightView, centerLS);

        const snappedX = Math.round(centerLS.x / worldUnitsPerTexel) * worldUnitsPerTexel;
        const snappedY = Math.round(centerLS.y / worldUnitsPerTexel) * worldUnitsPerTexel;

        const dx = centerLS.x - snappedX;
        const dy = centerLS.y - snappedY;

        light.position.addInPlace(lightRight.scale(dx));
        light.position.addInPlace(lightUp.scale(dy));
    }

    const shadowsObserver = scene.onBeforeRenderObservable.add(() => {
        const now = performance.now();
        if (now - lastPickMs > PICK_MS) {
            pickActivePlanetNow();
            lastPickMs = now;
        }
        if (!activePlanet) return;

        const starPosWorldDouble = activePlanet.starPosWorldDouble;
        if (!starPosWorldDouble) return;

        const camWorld = camera.doublepos;
        tmpStarRender.set(
            starPosWorldDouble.x - camWorld.x,
            starPosWorldDouble.y - camWorld.y,
            starPosWorldDouble.z - camWorld.z
        );

        const planetCenterWorld = activePlanet.entity.doublepos;
        tmpPlanetRender.set(
            planetCenterWorld.x - camWorld.x,
            planetCenterWorld.y - camWorld.y,
            planetCenterWorld.z - camWorld.z
        );

        lightDir.copyFrom(tmpPlanetRender).subtractInPlace(tmpStarRender);
        if (lightDir.lengthSquared() < 1e-12) return;
        lightDir.normalize();
        nearShadowLight.direction.copyFrom(lightDir);
        farShadowLight.direction.copyFrom(lightDir);

        camPosRender.copyFrom(camera.position);

        const distToCenter = camera.distanceToSim(planetCenterWorld);
        const altitude = Math.max(0, distToCenter - activePlanet.radiusSim);
        const targetNearRange = clampRange(
            altitude * 1.4 + 1200,
            MIN_NEAR_SHADOW_RANGE,
            MAX_NEAR_SHADOW_RANGE
        );
        const targetFarRange = clampRange(
            altitude * 4.0 + 9000,
            MIN_FAR_SHADOW_RANGE,
            MAX_FAR_SHADOW_RANGE
        );

        nearShadowRange += (targetNearRange - nearShadowRange) * RANGE_LERP;
        farShadowRange += (targetFarRange - farShadowRange) * RANGE_LERP;
        farShadowRange = Math.max(farShadowRange, nearShadowRange * 1.5);

        const upRef =
            Math.abs(Vector3.Dot(lightDir, Vector3.Up())) > 0.98
                ? Vector3.Forward()
                : Vector3.Up();
        Vector3.CrossToRef(upRef, lightDir, lightRight);
        lightRight.normalize();
        Vector3.CrossToRef(lightDir, lightRight, lightUp);
        lightUp.normalize();

        configureShadowCascade(nearShadowLight, nearShadowRange, NEAR_SHADOW_MAP_SIZE);
        configureShadowCascade(farShadowLight, farShadowRange, FAR_SHADOW_MAP_SIZE);

        shadowCtx.blendStart = nearShadowRange * 0.9;
        shadowCtx.blendEnd = Math.max(
            shadowCtx.blendStart + 1,
            Math.min(farShadowRange * 0.8, nearShadowRange * 1.8)
        );
        shadowCtx.near.lightMatrix.copyFrom(nearShadowGen.getTransformMatrix());
        shadowCtx.far.lightMatrix.copyFrom(farShadowGen.getTransformMatrix());
    });
    disposables.addBabylonObserver(scene.onBeforeRenderObservable, shadowsObserver);

    const stars: StarGlowSource[] = [];
    for (const system of loadedSystems.values()) {
        for (const body of system.bodies.values()) {
            if (body.bodyType !== 'star') continue;
            const light = body.starLight;
            stars.push({
                posWorldDouble: body.positionWorldDouble,
                radius: body.radiusSim,
                color: light?.color ?? new Vector3(1, 1, 1),
                intensity: light?.intensity ?? 1.0,
            });
        }
    }
    attachStarRayMarchingPostProcess(scene, camera, stars);

    return {
        lod,
        refreshActivePlanetSelection: () => {
            pickActivePlanetNow();
            lastPickMs = performance.now();
        },
    };
}
