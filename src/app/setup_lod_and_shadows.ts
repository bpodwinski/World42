import {
    Scene,
    Vector3,
    WebGPUEngine,
} from '@babylonjs/core';
import { OriginCamera } from '../core/camera/camera_manager';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import type { StarGlowSource, StarOccluder } from '../core/render/star_raymarch_postprocess';
import {
    createCBTForSystem,
    type LoadedSystem,
    type PlanetCBT,
} from '../game_world/stellar_system/stellar_catalog_loader';
import {
    CbtScheduler,
    type CbtAggregateStats,
    type CbtPlanetInfo,
} from '../systems/lod/cbt/cbt_scheduler';
import {
    CBT_QUALITY_PRESETS,
    noiseForQuality,
    type CbtQualityLevel,
} from '../systems/lod/cbt/cbt_quality';

/**
 * CBT quality preset. Change this to tune mesh density, max depth and terrain
 * detail in one place: 'low' | 'medium' | 'high' | 'ultra' (see cbt_quality.ts).
 */
const CBT_QUALITY: CbtQualityLevel = 'high';

export type LodController = {
    resetNow: () => void;
    /** Aggregate CBT telemetry for the perf HUD / headless capture. */
    getCbtStats: () => CbtAggregateStats;
    /** Per-planet centers/radii for deterministic headless capture (CBT planets). */
    getCbtPlanetInfo: () => CbtPlanetInfo[];
    /** Analytic hard-floor camera-vs-ground collision for CBT/OCBT planets. */
    resolveGroundCollision: (clearanceSim: number) => void;
    /** Nearest CBT/OCBT planet + terrain-aware ground radius under the camera (HUD altitude). */
    getCbtGroundInfo: () => {
        key: string;
        distSim: number;
        groundRSim: number;
        radiusSim: number;
    } | null;
};

export type LodSetupResult = {
    lod: LodController;
    refreshActivePlanetSelection: () => void;
    /** Star glow sources for the Frame Graph star ray-march task. */
    stars: StarGlowSource[];
    /** Planet occluders for the star ray-march task. */
    occluders: StarOccluder[];
};

type PlanetShadowSource = {
    entity: PlanetCBT['entity'];
    radiusSim: number;
    starPosWorldDouble: Vector3 | null;
};

export function setupLodAndShadows(
    scene: Scene,
    engine: WebGPUEngine,
    camera: OriginCamera,
    loadedSystems: Map<string, LoadedSystem>,
    disposables: DisposableRegistry
): LodSetupResult {
    const mergedCBT = new Map<string, PlanetCBT>();

    for (const system of loadedSystems.values()) {
        const quality = CBT_QUALITY_PRESETS[CBT_QUALITY];
        const cbt = createCBTForSystem(scene, camera, system, {
            noise: noiseForQuality(quality),
            engine,
        });

        for (const [name, planet] of cbt.entries()) {
            mergedCBT.set(`${system.systemId}:${name}`, planet);
        }
    }

    const cbtPlanets = Array.from(mergedCBT.values()).map((planet) => planet.runtime);
    const cbtScheduler = new CbtScheduler(scene, camera, cbtPlanets, {
        budgetMs: 2,
    });
    // Refine toward the spawn camera before the first render so the spawn planet
    // is not shown at minimum LOD while the per-frame budget ramps up.
    cbtScheduler.prewarm();
    cbtScheduler.start();
    disposables.add(() => cbtScheduler.dispose());

    const lod: LodController = {
        resetNow: () => cbtScheduler.resetNow(),
        getCbtStats: () => cbtScheduler.getStats(),
        getCbtPlanetInfo: () => cbtScheduler.getPlanetInfo(),
        resolveGroundCollision: (clearanceSim: number) =>
            cbtScheduler.resolveGroundCollision(clearanceSim),
        getCbtGroundInfo: () => cbtScheduler.getNearestGroundInfo(),
    };

    const mergedShadowPlanets = new Map<string, PlanetShadowSource>();
    for (const [key, planet] of mergedCBT.entries()) {
        mergedShadowPlanets.set(key, {
            entity: planet.entity,
            radiusSim: planet.radiusSim,
            starPosWorldDouble: planet.starPosWorldDouble,
        });
    }

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

    const planetOccluders: StarOccluder[] = Array.from(mergedShadowPlanets.values()).map((p) => ({
        posWorldDouble: p.entity.doublepos,
        radiusSim: p.radiusSim,
    }));
    // The star ray-march is now a Frame Graph task (see attachFrameGraph in setup_runtime); we just
    // surface the star/occluder data so the runtime can build the graph.

    return { lod, refreshActivePlanetSelection: () => {}, stars, occluders: planetOccluders };
}
