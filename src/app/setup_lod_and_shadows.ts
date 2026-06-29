import {
    Scene,
    Vector3,
    WebGPUEngine,
} from '@babylonjs/core';
import { OriginCamera } from '../core/camera/camera_manager';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import type { StarGlowSource, StarOccluder } from '../core/render/star_raymarch_postprocess';
import type { AtmosphereSource } from '../core/render/atmosphere_postprocess';
import {
    createTerrainForSystem,
    type LoadedSystem,
    type PlanetTerrain,
} from '../game_world/stellar_system/stellar_catalog_loader';
import {
    TerrainScheduler,
    type TerrainAggregateStats,
    type TerrainPlanetInfo,
} from '../systems/lod/terrain/terrain_scheduler';
import {
    TERRAIN_QUALITY_PRESETS,
    noiseForQuality,
    type TerrainQualityLevel,
} from '../systems/lod/terrain/terrain_quality';
import { resolveEffectiveProfile } from '../game_world/stellar_system/terrain_profile_store';

/**
 * TERRAIN quality preset. Change this to tune mesh density, max depth and terrain
 * detail in one place: 'low' | 'medium' | 'high' | 'ultra' (see terrain_quality.ts).
 */
const TERRAIN_QUALITY: TerrainQualityLevel = 'high';

export type LodController = {
    resetNow: () => void;
    /** Aggregate TERRAIN telemetry for the perf HUD / headless capture. */
    getTerrainStats: () => TerrainAggregateStats;
    /** Per-planet centers/radii for deterministic headless capture (TERRAIN planets). */
    getTerrainPlanetInfo: () => TerrainPlanetInfo[];
    /** Analytic hard-floor camera-vs-ground collision for TERRAIN/TERRAIN planets. */
    resolveGroundCollision: (clearanceSim: number) => void;
    /** Nearest TERRAIN/TERRAIN planet + terrain-aware ground radius under the camera (HUD altitude). */
    getTerrainGroundInfo: () => {
        key: string;
        distSim: number;
        groundRSim: number;
        radiusSim: number;
    } | null;
    /** Drives the heavy TERRAIN compute loop — invoked by the Frame Graph's TERRAIN compute task. */
    runTerrainCompute: () => void;
    /** Hand the TERRAIN compute loop to the Frame Graph (called once the graph is built). */
    setComputeOwnedByGraph: (owned: boolean) => void;
    /** Hot-rebuild every planet using `profileId` from its (now overridden) profile — no reload. */
    rebuildProfile: (profileId: string) => void;
};

export type LodSetupResult = {
    lod: LodController;
    refreshActivePlanetSelection: () => void;
    /** Star glow sources for the Frame Graph star ray-march task. */
    stars: StarGlowSource[];
    /** Planet occluders for the star ray-march task. */
    occluders: StarOccluder[];
    /** Atmospheric planets for the Frame Graph atmosphere task. */
    atmospheres: AtmosphereSource[];
};

type PlanetShadowSource = {
    entity: PlanetTerrain['entity'];
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
    const mergedTerrain = new Map<string, PlanetTerrain>();

    for (const system of loadedSystems.values()) {
        const quality = TERRAIN_QUALITY_PRESETS[TERRAIN_QUALITY];
        const terrain = createTerrainForSystem(scene, camera, system, {
            noise: noiseForQuality(quality),
            engine,
        });

        for (const [name, planet] of terrain.entries()) {
            mergedTerrain.set(`${system.systemId}:${name}`, planet);
        }
    }

    const terrainPlanets = Array.from(mergedTerrain.values()).map((planet) => planet.runtime);
    const terrainScheduler = new TerrainScheduler(scene, camera, terrainPlanets, {
        budgetMs: 2,
    });
    // Refine toward the spawn camera before the first render so the spawn planet
    // is not shown at minimum LOD while the per-frame budget ramps up.
    terrainScheduler.prewarm();
    terrainScheduler.start();
    disposables.add(() => terrainScheduler.dispose());

    const lod: LodController = {
        resetNow: () => terrainScheduler.resetNow(),
        getTerrainStats: () => terrainScheduler.getStats(),
        getTerrainPlanetInfo: () => terrainScheduler.getPlanetInfo(),
        resolveGroundCollision: (clearanceSim: number) =>
            terrainScheduler.resolveGroundCollision(clearanceSim),
        getTerrainGroundInfo: () => terrainScheduler.getNearestGroundInfo(),
        runTerrainCompute: () => terrainScheduler.runCompute(),
        setComputeOwnedByGraph: (owned: boolean) =>
            terrainScheduler.setGraphOwnsCompute(owned),
        rebuildProfile: (profileId: string) => {
            for (const planet of mergedTerrain.values()) {
                if (planet.profile !== profileId) continue;
                planet.runtime.rebuildTerrain(
                    resolveEffectiveProfile(profileId, planet.lightingOverride)
                );
            }
        },
    };

    const mergedShadowPlanets = new Map<string, PlanetShadowSource>();
    for (const [key, planet] of mergedTerrain.entries()) {
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

    // Atmospheric planets (bodies whose resolved lighting carries an atmosphere block).
    const atmospheres: AtmosphereSource[] = [];
    for (const planet of mergedTerrain.values()) {
        if (!planet.atmosphere) continue;
        atmospheres.push({
            centerWorldDouble: planet.entity.doublepos,
            radiusKm: planet.radiusSim, // 1 sim unit = 1 km
            starPosWorldDouble: planet.starPosWorldDouble,
            params: planet.atmosphere,
        });
    }

    return { lod, refreshActivePlanetSelection: () => {}, stars, occluders: planetOccluders, atmospheres };
}
