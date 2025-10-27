import {
    Scene,
    Vector3,
    MeshBuilder,
    PBRMetallicRoughnessMaterial,
    Color3,
    TransformNode
} from "@babylonjs/core";
import { FloatingEntity, OriginCamera } from "../../core/camera/camera-manager";
import { ScaleManager } from "../../core/scale/scale-manager";
import { ChunkTree, Face } from "../../systems/lod/chunks/chunkTree";

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

    /** Fallback si radiusMeters manquant (km -> unités simu si besoin) */
    fallbackRadiusKm?: number;
};

/** JSON shape attendu (ex: Sun/Earth/... -> { position_km, diameter_km, rotation_period_days }) */
export type BodyJSON = {
    position_km: [number, number, number];
    diameter_km: number | null;
    rotation_period_days: number | null; // durée d'un tour (sidéral). null -> pas de rotation animée
};
export type SystemJSON = Record<string, BodyJSON>;

export type LoadSystemOptions = {
    /** Rayon minimal de rendu en mètres pour ne pas “disparaître” (utile pour de très petits objets) */
    minRenderRadiusMeters?: number;

    /** Matériau par défaut (si non fourni, un PBR simple est créé) */
    makeMaterial?: (name: string, isStar: boolean, scene: Scene) => PBRMetallicRoughnessMaterial;

    /** Attacher tous les corps sous ce node (facile à déplacer/centrer) */
    parent?: TransformNode;

    /** Activer une animation de rotation au render loop */
    animateRotation?: boolean;
};

export type LoadedBody = {
    name: string;
    node: TransformNode;      // racine du corps
    meshName?: string;        // nom de la mesh (si créée)
    radiusMeters?: number;    // rayon utilisé pour la mesh
    rotationPeriodDays?: number | null;
};

export type LoadedSystem = {
    root: TransformNode;
    bodies: Map<string, LoadedBody>;
};

/**
 * Charge un JSON (URL, chemin relatif ou string JSON) et crée les corps dans la scène.
 * - Position interprétée en kilomètres dans le JSON -> convertie en mètres via metersPerKm
 * - diameter_km -> sphère (rayon = diameter/2) avec PBR de base ; "Sun" est traité comme étoile (émissif)
 * - rotation_period_days anime la rotation Y si animateRotation = true
 */
export async function loadSolarSystemFromJSON(
    scene: Scene,
    jsonSource: string | SystemJSON,
    opts: LoadSystemOptions = {}
): Promise<LoadedSystem> {
    const {
        minRenderRadiusMeters = 1,
        animateRotation = true,
        parent,
        makeMaterial = (name, isStar, scn) => {
            const mat = new PBRMetallicRoughnessMaterial(`mat_${name}`, scn);
            mat.baseColor = isStar ? new Color3(1, 0.95, 0.8) : new Color3(0.6, 0.6, 0.65);
            // Donne un côté "lumineux" au Soleil:
            if (isStar) {
                mat.emissiveColor = new Color3(1, 0.9, 0.6);
                mat.metallic = 0.0;
                mat.roughness = 1.0;
            } else {
                mat.metallic = 0.0;
                mat.roughness = 1.0;
            }
            return mat;
        }
    } = opts;

    const root = new TransformNode("SolarSystem", scene);
    if (parent) root.parent = parent;

    const system: SystemJSON =
        typeof jsonSource === "string"
            ? await (async () => {
                const isLikelyJsonString = jsonSource.trim().startsWith("{");
                if (isLikelyJsonString) return JSON.parse(jsonSource) as SystemJSON;
                const res = await fetch(jsonSource);
                if (!res.ok) throw new Error(`Failed to fetch JSON: ${res.status} ${res.statusText}`);
                return (await res.json()) as SystemJSON;
            })()
            : jsonSource;

    const bodies = new Map<string, LoadedBody>();

    // Création des corps
    Object.entries(system).forEach(([name, data]) => {
        const node = new TransformNode(`node_${name}`, scene);
        node.parent = root;

        // Position (km -> m)
        const [xKm, yKm, zKm] = data.position_km ?? [0, 0, 0];
        node.position = new Vector3(xKm, yKm, zKm);

        const isStar = name.toLowerCase() === "sun" || name.toLowerCase().includes("star");
        let meshName: string | undefined;
        let radiusMeters: number | undefined;

        if (data.diameter_km && data.diameter_km > 0) {
            radiusMeters = Math.max((data.diameter_km) / 2, minRenderRadiusMeters);
            const sphere = MeshBuilder.CreateSphere(`mesh_${name}`, { diameter: radiusMeters * 2, segments: 32 }, scene);
            sphere.parent = node;

            const mat = makeMaterial(name, isStar, scene);
            sphere.material = mat;

            meshName = sphere.name;
        }

        bodies.set(name, {
            name,
            node,
            meshName,
            radiusMeters,
            rotationPeriodDays: data.rotation_period_days ?? null
        });
    });

    // Animation des rotations (simple Yaw)
    if (animateRotation) {
        scene.onBeforeRenderObservable.add(() => {
            const dt = scene.getEngine().getDeltaTime() / 1000; // s
            bodies.forEach((b) => {
                const T = b.rotationPeriodDays;
                if (!T || !isFinite(T) || T === 0) return;
                // vitesse angulaire = 2π / période (en secondes)
                const omega = (2 * Math.PI) / (T * 86400);
                b.node.rotation.y += omega * dt;
            });
        });
    }

    return { root, bodies };
}

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
        skip = (name) => name.toLowerCase() === "sun",
        fallbackRadiusKm = 1000, // au cas où un corps n'a pas de diamètre
    } = opts;

    const out = new Map<string, PlanetCDLOD>();

    for (const [name, body] of loaded.bodies) {
        if (skip(name, body)) continue;

        // Entité flottante
        const ent = new FloatingEntity(`ent_${name}`, scene);
        ent.doublepos.set(body.node.position.x, body.node.position.y, body.node.position.z);
        camera.add(ent);

        // Rayon (m) si fourni, sinon fallback converti depuis km
        const radius =
            body.radiusMeters ??
            ScaleManager.toSimulationUnits(fallbackRadiusKm);

        const chunks = faces.map(
            (face) =>
                new ChunkTree(
                    scene,
                    camera,
                    { uMin: -1, uMax: 1, vMin: -1, vMax: 1 },
                    0,
                    maxLevel,
                    radius,
                    body.node.position, // position "double" pour le LOD
                    resolution,
                    face,
                    ent,
                    false,
                    false
                )
        );

        out.set(name, { entity: ent, chunks, radius, maxLevel, resolution });
    }

    return out;
}

export async function precomputeAndRunLODLoop(
    scene: Scene,
    camera: OriginCamera,
    all: Map<string, PlanetCDLOD>
) {
    const allChunks = Array.from(all.values()).flatMap(v => v.chunks);

    await Promise.all(allChunks.map(c => c.precomputeMesh()));

    async function loop() {
        while (true) {
            for (const c of allChunks) {
                c.updateLOD(camera, false).catch(console.error);
            }
            await new Promise<void>(r => requestAnimationFrame(() => r()));
        }
    }
    loop();
}
