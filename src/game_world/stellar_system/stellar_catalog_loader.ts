import {
    Scene,
    Vector3,
    MeshBuilder,
    PBRMetallicRoughnessMaterial,
    Color3,
    TransformNode,
} from "@babylonjs/core";

import { FloatingEntity, OriginCamera } from "../../core/camera/camera_manager";
import { ScaleManager } from "../../core/scale/scale_manager";
import { TextureManager } from "../../core/io/texture_manager";
import { ChunkTree } from "../../systems/lod/chunks/chunk_tree";
import type { Face } from "../../systems/lod/types";

/** ---------- Types JSON (catalogue) ---------- */
export type BodyJSON = {
    type: string; // "star" | "planet" | ...
    position_km: [number, number, number];
    diameter_km: number;
    rotation_period_days: number | null;
};

export type SystemJSON = Record<string, BodyJSON>;

/** Format recommandé (multi-systèmes) */
export type StellarSystemJSON = {
    /** Optionnel: origine du système dans la "galaxie" */
    origin_km?: [number, number, number];
    /** Optionnel: nom affiché */
    displayName?: string;
    /** Corps du système */
    bodies: SystemJSON;
};

export type StellarCatalogJSON = {
    /** id -> system */
    systems: Record<string, StellarSystemJSON>;
    /** optionnel: système par défaut */
    default?: string;
};

/** ---------- Runtime Loaded ---------- */

export type LoadedBody = {
    systemId: string;
    bodyType: string;
    name: string;

    /** Pivot Render-space (rotation/tilt), parenté sous FloatingEntity */
    node: TransformNode;

    meshName: string;

    /** WorldDouble (simulation units) */
    positionWorldDouble: Vector3;

    diameter: number;
    rotationPeriodDays: number | null;

    entity?: FloatingEntity;
};

export type LoadedSystem = {
    systemId: string;
    root: TransformNode; // sys_<systemId>
    bodies: Map<string, LoadedBody>;
};

export type PlanetCDLOD = {
    entity: FloatingEntity;
    chunks: ChunkTree[];
    radius: number;
    maxLevel: number;
    resolution: number;
};

export type CDLODOptions = {
    maxLevel?: number;
    resolution?: number;
    skip?: (name: string, body: LoadedBody) => boolean;
    faces?: Face[];
};

export type LoadSystemOptions = {
    parent?: TransformNode;
    animateRotation?: boolean;
    makeMaterial?: (name: string, isStar: boolean, scene: Scene) => PBRMetallicRoughnessMaterial;
};

/** ---------- API ---------- */

/** Liste des systèmes disponibles (compat ancien format inclus). */
export function listStellarSystems(jsonSource: unknown): string[] {
    const cat = normalizeCatalogJSON(jsonSource);
    return Object.keys(cat.systems);
}

/**
 * Build un système (par id) et renvoie (root, bodies).
 * Nommage sans collisions:
 * - root: sys_<systemId>
 * - ent : ent_<systemId>_<Body>
 * - pivot: pivot_<systemId>_<Body>
 * - body mesh: body_<systemId>_<Body>
 */
export async function loadStellarSystemFromCatalog(
    scene: Scene,
    jsonSource: unknown,
    systemId: string,
    opts: LoadSystemOptions = {}
): Promise<LoadedSystem> {
    const {
        parent,
        animateRotation = true,
        makeMaterial = (name: string, isStar: boolean, scene: Scene) => {
            const mat = new PBRMetallicRoughnessMaterial(`mat_${name}`, scene);
            if (isStar) {
                mat.emissiveTexture = new TextureManager("sun_surface_albedo.ktx2", scene);
                mat.emissiveColor = new Color3(1, 1, 1);
                mat.metallic = 0.0;
                mat.roughness = 0.0;
            } else {
                mat.baseColor = new Color3(0.6, 0.6, 0.65);
                mat.metallic = 0.0;
                mat.roughness = 1.0;
            }
            return mat;
        },
    } = opts;

    const catalog = normalizeCatalogJSON(jsonSource);
    const sys = catalog.systems[systemId];
    if (!sys) {
        throw new Error(`[stellar] unknown systemId="${systemId}". Available: ${Object.keys(catalog.systems).join(", ")}`);
    }

    const root = new TransformNode(`sys_${systemId}`, scene);
    if (parent) root.parent = parent;

    const originKm = sys.origin_km ?? [0, 0, 0];
    const originWorldDouble = ScaleManager.toSimulationVector(new Vector3(originKm[0], originKm[1], originKm[2]));

    const bodiesJson = normalizeSystemJSON(sys.bodies);
    const bodies = new Map<string, LoadedBody>();

    for (const [name, data] of Object.entries(bodiesJson)) {
        const type = canonicalType(data.type);
        const isStar = type === "star";

        const pivot = new TransformNode(`pivot_${systemId}_${name}`, scene);
        pivot.parent = root;
        pivot.position.set(0, 0, 0);

        const pKm = data.position_km;
        const posWorldDouble = originWorldDouble.add(
            ScaleManager.toSimulationVector(new Vector3(pKm[0], pKm[1], pKm[2]))
        );

        const diameter = ScaleManager.toSimulationUnits(data.diameter_km);

        let meshName = `body_${systemId}_${name}`;
        if (isStar) {
            const sphere = MeshBuilder.CreateSphere(meshName, { diameter, segments: 64 }, scene);
            sphere.parent = pivot;
            sphere.material = makeMaterial(`${systemId}_${name}`, true, scene);
            meshName = sphere.name;
        }

        bodies.set(name, {
            systemId,
            bodyType: type,
            name,
            node: pivot,
            meshName,
            positionWorldDouble: posWorldDouble,
            diameter,
            rotationPeriodDays: data.rotation_period_days,
        });
    }

    if (animateRotation) {
        scene.onBeforeRenderObservable.add(() => {
            const dt = scene.getEngine().getDeltaTime() / 1000;
            bodies.forEach((b) => {
                const T = b.rotationPeriodDays;
                if (!T || !isFinite(T) || T === 0) return;
                const omega = (2 * Math.PI) / (T * 86400);
                b.node.rotation.y += omega * dt;
            });
        });
    }

    return { systemId, root, bodies };
}

/**
 * Crée les FloatingEntity pour tous les corps du système,
 * puis crée le CDLOD pour ceux qui ne sont pas skip.
 *
 * NOTE: dépend d’un OriginCamera (floating origin).
 */
export function createCDLODForSystem(
    scene: Scene,
    camera: OriginCamera,
    loaded: LoadedSystem,
    opts: CDLODOptions = {}
): Map<string, PlanetCDLOD> {
    const {
        maxLevel = 8,
        resolution = 64,
        faces = ["front", "back", "left", "right", "top", "bottom"],
        skip = (_name: string, body: LoadedBody) => body.bodyType === "star",
    } = opts;

    // attacher entités flottantes (noms namespacés)
    for (const [name, body] of loaded.bodies) {
        if (!body.entity) {
            const ent = new FloatingEntity(`ent_${loaded.systemId}_${name}`, scene);
            ent.parent = loaded.root; // rangement
            ent.doublepos.copyFrom(body.positionWorldDouble);
            camera.add(ent);

            body.node.parent = ent;
            body.node.position.set(0, 0, 0);
            body.entity = ent;
        }
    }

    const out = new Map<string, PlanetCDLOD>();

    for (const [name, body] of loaded.bodies) {
        if (skip(name, body)) continue;

        const ent = body.entity!;
        const radius = body.diameter * 0.5;

        const star = Array.from(loaded.bodies.values()).find(b => b.bodyType === "star");
        const starPosWorldDouble = star?.positionWorldDouble ?? null;

        const chunks = faces.map((face) =>
            new ChunkTree(
                scene,
                camera,
                { uMin: -1, uMax: 1, vMin: -1, vMax: 1 },
                0,
                maxLevel,
                radius,
                resolution,
                face,
                ent,       // WorldDouble anchor
                body.node, // pivot (rotation) => chunks tournent
                starPosWorldDouble,
                false,
                false,
                true,
                true,
                true
            )
        );

        out.set(name, { entity: ent, chunks, radius, maxLevel, resolution });
    }

    return out;
}

/** ---------- Normalisation / compat ---------- */

function canonicalType(typeRaw: unknown): string {
    let t = (typeof typeRaw === "string" ? typeRaw : "planet").toLowerCase().trim();
    if (t === "sun") t = "star";
    return t;
}

/**
 * Compat:
 * - Si raw a {systems:{...}} -> catalogue
 * - Sinon -> on considère que raw est un SystemJSON unique -> wrap sous "Sol"
 */
function normalizeCatalogJSON(raw: unknown): StellarCatalogJSON {
    // multi-systèmes
    if (raw && typeof raw === "object" && (raw as any).systems && typeof (raw as any).systems === "object") {
        const systemsIn = (raw as any).systems as Record<string, any>;
        const systems: Record<string, StellarSystemJSON> = {};

        for (const [sysId, sysAny] of Object.entries(systemsIn)) {
            // accepte soit {bodies:{...}} soit directement {...bodies...} (fallback)
            const bodiesAny = (sysAny && typeof sysAny === "object" && (sysAny as any).bodies)
                ? (sysAny as any).bodies
                : sysAny;

            systems[sysId] = {
                origin_km: Array.isArray((sysAny as any)?.origin_km) ? (sysAny as any).origin_km : undefined,
                displayName: typeof (sysAny as any)?.displayName === "string" ? (sysAny as any).displayName : undefined,
                bodies: normalizeSystemJSON(bodiesAny),
            };
        }

        const def = typeof (raw as any).default === "string" ? (raw as any).default : undefined;
        return { systems, default: def };
    }

    // ancien format: un seul système bodies
    return {
        systems: {
            Sol: { bodies: normalizeSystemJSON(raw) },
        },
        default: "Sol",
    };
}

function normalizeSystemJSON(raw: unknown): SystemJSON {
    const out: SystemJSON = {};
    if (typeof raw !== "object" || raw === null) return out;

    for (const [name, vAny] of Object.entries(raw as Record<string, any>)) {
        const v = vAny ?? {};
        const type = canonicalType(v.type ?? v.Type);

        let x = 0, y = 0, z = 0;
        if (Array.isArray(v.position_km)) {
            [x = 0, y = 0, z = 0] = v.position_km as number[];
        } else {
            x = Number(v.x ?? 0);
            y = Number(v.y ?? 0);
            z = Number(v.z ?? 0);
        }

        const diameter_km = Number(v.diameter_km ?? v.diameter ?? 0);
        const rot = v.rotation_period_days;
        const rotation_period_days = rot === null || rot === undefined ? null : Number(rot);

        out[name] = {
            type,
            position_km: [x, y, z],
            diameter_km: Number.isFinite(diameter_km) ? diameter_km : 0,
            rotation_period_days: Number.isFinite(Number(rotation_period_days)) ? Number(rotation_period_days) : null,
        };
    }

    return out;
}

export function runCDLODLoop(
    scene: Scene,
    camera: OriginCamera,
    all: Map<string, PlanetCDLOD>
) {
    const roots = Array.from(all.values()).flatMap((p) => p.chunks);
    let inFlight = false;

    scene.onBeforeRenderObservable.add(() => {
        if (inFlight) return;
        inFlight = true;

        Promise.all(roots.map((c) => c.updateLOD(camera, false)))
            .catch(console.error)
            .finally(() => {
                inFlight = false;
            });

        for (const c of roots) c.updateDebugLOD(ChunkTree.debugLODEnabled);
    });
}