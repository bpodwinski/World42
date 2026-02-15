import type { Scene } from "@babylonjs/core";
import {
    createCDLODForSystem,
    listStellarSystems,
    loadStellarSystemFromCatalog,
    PlanetCDLOD,
} from "../stellar_system/stellar_catalog_loader";
import { OriginCamera } from "../../core/camera/camera_manager";

export type LoadedSystem = Awaited<ReturnType<typeof loadStellarSystemFromCatalog>>;
export type SystemBody = LoadedSystem["bodies"] extends Map<any, infer V> ? V : never;

export type StellarSystemRuntime = {
    systemIds: string[];
    loadedSystemsArr: LoadedSystem[];
    loadedSystems: Map<string, LoadedSystem>;
    activeSystem: LoadedSystem;
    spawnBody: SystemBody;
};

export type StellarSystemPlanetsBuild = {
    mergedCDLOD: Map<string, PlanetCDLOD>;
    roots: any[]; // si tu as un type ChunkNode/ChunkTreeNode, remplace `any[]`
};

export async function loadStellarSystemRuntime(
    scene: Scene,
    catalogJson: any,
    opts: {
        preferredSystemId?: string;
        preferredBodyName?: string;
    } = {}
): Promise<StellarSystemRuntime> {
    const preferredSystemId = opts.preferredSystemId ?? "Sol";
    const preferredBodyName = opts.preferredBodyName ?? "Mercury";

    const systemIds = listStellarSystems(catalogJson);

    const loadedSystemsArr = await Promise.all(
        systemIds.map((id) => loadStellarSystemFromCatalog(scene, catalogJson, id))
    );

    const loadedSystems = new Map<string, LoadedSystem>(
        loadedSystemsArr.map((s) => [s.systemId, s])
    );

    const activeSystem = loadedSystems.get(preferredSystemId) ?? loadedSystemsArr[0];
    if (!activeSystem) {
        throw new Error("Aucun système stellaire chargé (catalogue vide ?).");
    }

    const bodies = activeSystem.bodies;
    const spawnBody =
        bodies.get(preferredBodyName) ??
        Array.from(bodies.values()).find((b: any) => b.bodyType !== "star");

    if (!spawnBody) {
        throw new Error("Aucun corps (planète) trouvé dans le système actif.");
    }

    return {
        systemIds,
        loadedSystemsArr,
        loadedSystems,
        activeSystem,
        spawnBody,
    };
}

export function buildStellarSystemPlanetsCDLOD(
    scene: Scene,
    camera: OriginCamera,
    loadedSystems: Map<string, LoadedSystem>,
    opts: {
        maxLevel: number;
        resolution: number;
    }
): StellarSystemPlanetsBuild {
    const mergedCDLOD = new Map<string, PlanetCDLOD>();

    for (const sys of loadedSystems.values()) {
        const cdlod = createCDLODForSystem(scene, camera, sys, {
            maxLevel: opts.maxLevel,
            resolution: opts.resolution,
        });

        for (const [name, planet] of cdlod.entries()) {
            mergedCDLOD.set(`${sys.systemId}:${name}`, planet);
        }
    }

    const roots = Array.from(mergedCDLOD.values()).flatMap((p) => p.chunks);

    return { mergedCDLOD, roots };
}
