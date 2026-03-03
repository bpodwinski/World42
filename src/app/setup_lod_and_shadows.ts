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
import { attachStarRayMarchingPostProcess, type StarGlowSource } from '../core/render/star_raymarch_postprocess';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import {
    createCDLODForSystem,
    type LoadedSystem,
    type PlanetCDLOD,
} from '../game_world/stellar_system/stellar_catalog_loader';
import { TerrainShader, type TerrainShadowContext } from '../game_objects/planets/rocky_planet/terrains_shader';
import { LodScheduler } from '../systems/lod/lod_scheduler';

export type LodSetupResult = {
    lod: LodScheduler;
    refreshActivePlanetSelection: () => void;
};

export function setupLodAndShadows(
    scene: Scene,
    engine: Engine | WebGPUEngine,
    camera: OriginCamera,
    loadedSystems: Map<string, LoadedSystem>,
    disposables: DisposableRegistry
): LodSetupResult {
    const mergedCDLOD = new Map<string, PlanetCDLOD>();

    for (const system of loadedSystems.values()) {
        const cdlod = createCDLODForSystem(scene, camera, system, {
            maxLevel: 12,
            resolution: 96,
        });

        for (const [name, planet] of cdlod.entries()) {
            mergedCDLOD.set(`${system.systemId}:${name}`, planet);
        }
    }

    const roots = Array.from(mergedCDLOD.values()).flatMap((planet) => planet.chunks);
    const lod = new LodScheduler(scene, camera, roots, {
        maxConcurrent: 8,
        maxStartsPerFrame: 2,
        rescoreMs: 100,
        applyDebugEveryFrame: true,
        budgetMs: 30,
    });
    lod.start();
    disposables.add(() => lod.stop());

    const SHADOW_MAP_SIZE = 4096;
    const MIN_SHADOW_RANGE = 6000;
    const MAX_SHADOW_RANGE = 50000;
    const RANGE_LERP = 0.12;
    const DEPTH_HALF_MULT = 2.0;
    const LIGHT_DIST_MULT = 2.5;
    const LIGHT_DIST_ADD = 5000;

    let shadowRange = 12000;

    const shadowLight = new DirectionalLight('terrainShadowLight', new Vector3(0, -1, 0), scene);
    shadowLight.intensity = 0;
    const shadowGen = new ShadowGenerator(SHADOW_MAP_SIZE, shadowLight, true);
    shadowGen.bias = 0.0015;
    shadowGen.normalBias = 0.6;

    const shadowMap = shadowGen.getShadowMapForRendering();
    if (!shadowMap) {
        throw new Error('Shadow map is unavailable for terrain shadow context.');
    }

    const shadowCtx: TerrainShadowContext = {
        shadowGen,
        shadowMap,
        lightMatrix: new Matrix(),
        texelSize: new Vector2(1 / SHADOW_MAP_SIZE, 1 / SHADOW_MAP_SIZE),
        bias: 0.00025,
        normalBias: 0.002,
        darkness: 1,
        reverseDepth: engine.useReverseDepthBuffer ? 1 : 0,
    };
    TerrainShader.setTerrainShadowContext(scene, shadowCtx);
    disposables.add(() => TerrainShader.setTerrainShadowContext(scene, null));

    let activePlanet: PlanetCDLOD | null = null;
    let lastPickMs = 0;
    const PICK_MS = 250;

    function pickActivePlanetNow(): void {
        let best: PlanetCDLOD | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const planet of mergedCDLOD.values()) {
            const distance = camera.distanceToSim(planet.entity.doublepos);
            if (distance < bestDistance) {
                best = planet;
                bestDistance = distance;
            }
        }
        activePlanet = best;
    }
    pickActivePlanetNow();

    function quantizeRange(range: number): number {
        const base = 2000;
        const quantized = base * Math.pow(2, Math.round(Math.log(range / base) / Math.log(2)));
        return Math.min(MAX_SHADOW_RANGE, Math.max(MIN_SHADOW_RANGE, quantized));
    }

    const tmpStarRender = new Vector3();
    const tmpPlanetRender = new Vector3();
    const lightDir = new Vector3();
    const camPosRender = new Vector3();
    const lightRight = new Vector3();
    const lightUp = new Vector3();
    const lightView = new Matrix();
    const centerLS = new Vector3();

    const shadowsObserver = scene.onBeforeRenderObservable.add(() => {
        const now = performance.now();
        if (now - lastPickMs > PICK_MS) {
            pickActivePlanetNow();
            lastPickMs = now;
        }
        if (!activePlanet) return;

        const starPosWorldDouble = activePlanet.chunks[0]?.starPosWorldDouble;
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
        shadowLight.direction.copyFrom(lightDir);

        camPosRender.copyFrom(camera.position);

        const distToCenter = camera.distanceToSim(planetCenterWorld);
        const altitude = Math.max(0, distToCenter - activePlanet.radiusSim);
        const targetRange = Math.min(
            MAX_SHADOW_RANGE,
            Math.max(MIN_SHADOW_RANGE, altitude * 2 + 2000)
        );

        shadowRange += (quantizeRange(targetRange) - shadowRange) * RANGE_LERP;
        const lightDistance = shadowRange * LIGHT_DIST_MULT + LIGHT_DIST_ADD;

        shadowLight.orthoLeft = -shadowRange;
        shadowLight.orthoRight = shadowRange;
        shadowLight.orthoTop = shadowRange;
        shadowLight.orthoBottom = -shadowRange;

        const depthHalf = shadowRange * DEPTH_HALF_MULT;
        shadowLight.shadowMinZ = Math.max(0.1, lightDistance - depthHalf);
        shadowLight.shadowMaxZ = lightDistance + depthHalf;
        shadowLight.position.copyFrom(camPosRender).subtractInPlace(lightDir.scale(lightDistance));

        const worldUnitsPerTexel = (2 * shadowRange) / SHADOW_MAP_SIZE;
        Matrix.LookAtLHToRef(
            shadowLight.position,
            shadowLight.position.add(shadowLight.direction),
            Vector3.Up(),
            lightView
        );
        Vector3.TransformCoordinatesToRef(camPosRender, lightView, centerLS);

        const snappedX = Math.round(centerLS.x / worldUnitsPerTexel) * worldUnitsPerTexel;
        const snappedY = Math.round(centerLS.y / worldUnitsPerTexel) * worldUnitsPerTexel;

        const dx = centerLS.x - snappedX;
        const dy = centerLS.y - snappedY;

        const upRef =
            Math.abs(Vector3.Dot(lightDir, Vector3.Up())) > 0.98
                ? Vector3.Forward()
                : Vector3.Up();
        Vector3.CrossToRef(upRef, lightDir, lightRight);
        lightRight.normalize();
        Vector3.CrossToRef(lightDir, lightRight, lightUp);
        lightUp.normalize();

        shadowLight.position.addInPlace(lightRight.scale(dx));
        shadowLight.position.addInPlace(lightUp.scale(dy));
        shadowCtx.lightMatrix.copyFrom(shadowGen.getTransformMatrix());
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
