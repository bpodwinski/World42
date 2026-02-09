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
import { ChunkTree } from "../../systems/lod/chunks/chunk_tree";
import { TextureManager } from "../../core/io/texture_manager";
import { Face } from "../../systems/lod/types";

export type PlanetCDLOD = {
    entity: FloatingEntity;
    chunks: ChunkTree[];
    radius: number;
    maxLevel: number;
    resolution: number;
};

export type CDLODOptions = {
    /** Niveaux de LOD max (par défaut 8) */
    maxLevel?: number;

    /** Résolution de base des patches (par défaut 64) */
    resolution?: number;

    /** Sauter certains corps (ex: Sun) */
    skip?: (name: string, body: LoadedBody) => boolean;

    /** Faces à générer (par défaut le cube complet) */
    faces?: Face[];
};

/** JSON shape attendu (ex: Sun/Earth/... -> { position_km, diameter_km, rotation_period_days }) */
export type BodyJSON = {
    type: string;
    position_km: [number, number, number];
    diameter_km: number;
    rotation_period_days: number | null;
};

export type SystemJSON = Record<string, BodyJSON>;

export type LoadSystemOptions = {
    /** Matériau par défaut (si non fourni, un PBR simple est créé) */
    makeMaterial?: (name: string, isStar: boolean, scene: Scene) => PBRMetallicRoughnessMaterial;

    /** Attacher tous les corps sous ce node (organisation) */
    parent?: TransformNode;

    /** Activer une animation de rotation au render loop */
    animateRotation?: boolean;
};

export type LoadedBody = {
    bodyType: string;
    name: string;

    /**
     * Pivot du corps en Render-space.
     * IMPORTANT: on le laisse à (0,0,0) et on le parent sous une FloatingEntity.
     */
    node: TransformNode;

    /** Nom de la mesh (si créée) */
    meshName: string;

    /** Position vraie du corps en WorldDouble (simulation units) */
    positionWorldDouble: Vector3;

    /** Diamètre en simulation units */
    diameter: number;

    rotationPeriodDays: number | null;

    /** Entité flottante associée (créée plus tard quand on a la caméra) */
    entity?: FloatingEntity;
};

export type LoadedSystem = {
    root: TransformNode;
    bodies: Map<string, LoadedBody>;
};

/**
 * Charge un JSON et crée les pivots/meshes.
 * - Les positions en km sont converties en simulation units, stockées dans positionWorldDouble
 * - Les nodes Babylon restent à (0,0,0) (Render-space), en attente d’un parent FloatingEntity
 */
export async function loadSolarSystemFromJSON(
    scene: Scene,
    jsonSource: SystemJSON | unknown,
    opts: LoadSystemOptions = {}
): Promise<LoadedSystem> {
    const {
        animateRotation = true,
        parent,
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

    const root = new TransformNode("SolarSystem", scene);
    if (parent) root.parent = parent;

    const system: SystemJSON = normalizeSystemJSON(jsonSource);
    const bodies = new Map<string, LoadedBody>();

    for (const [name, data] of Object.entries(system)) {
        const node = new TransformNode(`node_${name}`, scene);
        node.parent = root;

        // Canonique: "sun" est normalisé en "star"
        const isStar = data.type === "star";

        // Position vraie (km -> simulation units) stockée en WorldDouble
        const [xKm, yKm, zKm] = data.position_km;
        const posKm = new Vector3(xKm, yKm, zKm);
        const positionWorldDouble = ScaleManager.toSimulationVector(posKm);

        // Pivot Babylon en render-space (sera placé via FloatingEntity)
        node.position.set(0, 0, 0);

        const diameterSim = ScaleManager.toSimulationUnits(data.diameter_km);

        // (Optionnel) mesh pour les étoiles
        let meshName = `mesh_${name}`;
        if (isStar) {
            const sphere = MeshBuilder.CreateSphere(
                meshName,
                { diameter: diameterSim, segments: 64 },
                scene
            );
            sphere.parent = node;
            sphere.material = makeMaterial(name, true, scene);
            meshName = sphere.name;
        }

        bodies.set(name, {
            bodyType: data.type,
            name,
            node,
            meshName,
            positionWorldDouble,
            diameter: diameterSim,
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

    return { root, bodies };
}

/**
 * P0: crée/attache une FloatingEntity à chaque corps (y compris les étoiles),
 * puis ne génère le CDLOD que pour ceux qui ne sont pas skip.
 */
export function createCDLODForAllPlanets(
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

    // 1) P0: attacher toutes les bodies sous une FloatingEntity (même si skip)
    for (const [name, body] of loaded.bodies) {
        if (!body.entity) {
            const ent = new FloatingEntity(`ent_${name}`, scene);
            ent.parent = loaded.root;
            ent.doublepos.copyFrom(body.positionWorldDouble); // WorldDouble en simulation units
            camera.add(ent);

            body.node.parent = ent;       // pivot en Render-space sous l’entité flottante
            body.node.position.set(0, 0, 0);

            body.entity = ent;
        } else {
            // s’assure de la cohérence si déjà existante
            body.entity.parent = loaded.root;
            body.entity.doublepos.copyFrom(body.positionWorldDouble);
            body.node.parent = body.entity;
            body.node.position.set(0, 0, 0);
        }
    }

    // 2) Générer CDLOD uniquement pour les planètes (ou non skip)
    const out = new Map<string, PlanetCDLOD>();

    for (const [name, body] of loaded.bodies) {
        if (skip(name, body)) continue;

        const ent = body.entity!;
        const radius = body.diameter * 0.5;

        const chunks = faces.map(
            (face) =>
                new ChunkTree(
                    scene,
                    camera,
                    { uMin: -1, uMax: 1, vMin: -1, vMax: 1 },
                    0,
                    maxLevel,
                    radius,
                    resolution,
                    face,
                    ent,
                    body.node,
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

// (P1) Cette boucle sera supprimée/remplacée par LodController.tick() budgété.
// Ici inchangé pour P0.
export function precomputeAndRunLODLoop(scene: Scene, camera: OriginCamera, all: Map<string, PlanetCDLOD>) {
    const allChunks = Array.from(all.values()).flatMap(v => v.chunks);
    let inFlight = false;

    scene.onBeforeRenderObservable.add(() => {
        if (inFlight) return;
        inFlight = true;

        Promise.all(allChunks.map(c => c.updateLOD(camera, false)))
            .catch(console.error)
            .finally(() => { inFlight = false; });

        for (const c of allChunks) c.updateDebugLOD(ChunkTree.debugLODEnabled);
    });
}

function normalizeSystemJSON(raw: unknown): SystemJSON {
    const out: SystemJSON = {};
    if (typeof raw !== "object" || raw === null) return out;

    for (const [name, vAny] of Object.entries(raw as Record<string, any>)) {
        const v = vAny ?? {};

        // type: accepte "star"/"sun"/"planet" (insensible à la casse), défaut "planet"
        const typeRaw =
            typeof v.type === "string"
                ? v.type
                : typeof v.Type === "string"
                    ? v.Type
                    : "planet";

        let type = String(typeRaw).toLowerCase().trim();
        if (type === "sun") type = "star"; // canonicalisation P0

        // position: préfère position_km: [x,y,z], sinon fallback 0,0,0
        let x = 0,
            y = 0,
            z = 0;
        if (Array.isArray(v.position_km)) {
            [x = 0, y = 0, z = 0] = v.position_km as number[];
        } else if (
            typeof v.x === "number" ||
            typeof v.y === "number" ||
            typeof v.z === "number"
        ) {
            x = Number(v.x ?? 0);
            y = Number(v.y ?? 0);
            z = Number(v.z ?? 0);
        }

        // diamètre: accepte diameter_km ou diameter
        const diameter_km = Number(v.diameter_km ?? v.diameter ?? 0);
        const rot = v.rotation_period_days;
        const rotation_period_days = rot === null || rot === undefined ? null : Number(rot);

        out[name] = {
            type,
            position_km: [x, y, z],
            diameter_km: Number.isFinite(diameter_km) ? diameter_km : 0,
            rotation_period_days: Number.isFinite(Number(rotation_period_days))
                ? Number(rotation_period_days)
                : null,
        };
    }

    return out;
}
