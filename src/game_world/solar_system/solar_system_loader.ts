import {
    Scene,
    Vector3,
    MeshBuilder,
    PBRMetallicRoughnessMaterial,
    Color3,
    TransformNode,
} from "@babylonjs/core";
import { FloatingEntity, OriginCamera } from "../../core/camera/camera_manager";
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

    /** Attacher tous les corps sous ce node (facile à déplacer/centrer) */
    parent?: TransformNode;

    /** Activer une animation de rotation au render loop */
    animateRotation?: boolean;
};

export type LoadedBody = {
    bodyType: string;
    name: string;
    node: TransformNode;    // racine du corps
    meshName: string;       // nom de la mesh (si créée)
    diameter: number;       // diamètre utilisé pour la mesh
    rotationPeriodDays: number | null;
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
    jsonSource: SystemJSON | unknown,
    opts: LoadSystemOptions = {}
): Promise<LoadedSystem> {
    const {
        animateRotation = true,
        parent,
        makeMaterial = (name: string, isStar: boolean, scene: Scene) => {
            // Un seul mat, paramétré selon isStar
            const mat = new PBRMetallicRoughnessMaterial(`mat_${name}`, scene);

            if (isStar) {
                // Texture émissive (KTX2 ok si le loader est importé quelque part dans l’app)
                mat.emissiveTexture = new TextureManager('sun_surface_albedo.ktx2', scene);
                mat.emissiveColor = new Color3(1, 1, 1);
                mat.metallic = 0.0;
                mat.roughness = 0.0;
                // Optionnel : visible de l'intérieur si tu te téléportes dedans
                // mat.backFaceCulling = false;
            } else {
                mat.baseColor = new Color3(0.6, 0.6, 0.65);
                mat.metallic = 0.0;
                mat.roughness = 1.0;
            }

            return mat;
        }
    } = opts;

    const root = new TransformNode("SolarSystem", scene);
    if (parent) root.parent = parent;

    const system: SystemJSON = normalizeSystemJSON(jsonSource);
    const bodies = new Map<string, LoadedBody>();

    // Création des corps
    Object.entries(system).forEach(([name, data]) => {
        const node = new TransformNode(`node_${name}`, scene);
        node.parent = root;

        // Normalise le type (star/planet/...)
        const isStar = data.type === "star";

        // Position (km -> m)
        const [xKm, yKm, zKm] = data.position_km;
        node.position = new Vector3(xKm, yKm, zKm);

        let meshName = `mesh_${name}`;

        if (isStar) {
            const sphere = MeshBuilder.CreateSphere(meshName, { diameter: data.diameter_km, segments: 64 }, scene);
            sphere.parent = node;

            const mat = makeMaterial(name, isStar, scene);

            mat.emissiveColor = new Color3(1, 1, 1);
            mat.metallic = 0.0;
            mat.roughness = 0.0;

            sphere.material = mat;

            meshName = sphere.name;
        }

        bodies.set(name, {
            bodyType: data.type,
            name,
            node,
            meshName,
            diameter: data.diameter_km,
            rotationPeriodDays: data.rotation_period_days
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
        skip = (_name: string, body: LoadedBody) => body.bodyType === "star",
    } = opts;

    const out = new Map<string, PlanetCDLOD>();

    for (const [name, body] of loaded.bodies) {
        if (skip(name, body)) continue;

        // Entité flottante
        const ent = new FloatingEntity(`ent_${name}`, scene);
        ent.doublepos.set(body.node.position.x, body.node.position.y, body.node.position.z);
        camera.add(ent);

        const chunks = faces.map(
            (face) =>
                new ChunkTree(
                    scene,
                    camera,
                    { uMin: -1, uMax: 1, vMin: -1, vMax: 1 },
                    0,
                    maxLevel,
                    (body.diameter * 0.5),
                    resolution,
                    face,
                    ent,
                    false, // wireframe
                    false, // boundingBox
                    true, // frustumCulling
                    true, // backsideCulling
                    true // debugLOD
                )
        );

        out.set(name, { entity: ent, chunks, radius: (body.diameter * 0.5), maxLevel, resolution });
    }

    return out;
}

export async function precomputeAndRunLODLoop(
    scene: Scene,
    camera: OriginCamera,
    all: Map<string, PlanetCDLOD>
) {
    const allChunks = Array.from(all.values()).flatMap(v => v.chunks);

    async function loop() {
        while (true) {
            for (const chunk of allChunks) {
                chunk.updateLOD(camera, false).catch(console.error);
                chunk.updateDebugLOD(ChunkTree.debugLODEnabled);
            }
            await new Promise<void>(r => requestAnimationFrame(() => r()));
        }
    }

    loop();
}

function normalizeSystemJSON(raw: unknown): SystemJSON {
    const out: SystemJSON = {};

    if (typeof raw !== "object" || raw === null) return out;

    for (const [name, vAny] of Object.entries(raw as Record<string, any>)) {
        const v = vAny ?? {};

        // type: accepte "star"/"sun"/"planet", insensible à la casse, défaut "planet"
        const typeRaw =
            typeof v.type === "string" ? v.type :
                typeof v.Type === "string" ? v.Type :
                    "planet";
        const type = String(typeRaw).toLowerCase().trim();

        // position: préfère position_km: [x,y,z], sinon fallback 0,0,0
        let x = 0, y = 0, z = 0;
        if (Array.isArray(v.position_km)) {
            [x = 0, y = 0, z = 0] = v.position_km as number[];
        } else if (typeof v.x === "number" || typeof v.y === "number" || typeof v.z === "number") {
            x = Number(v.x ?? 0); y = Number(v.y ?? 0); z = Number(v.z ?? 0);
        }

        // diamètre: accepte diameter_km ou diameter
        const diameter_km = Number(v.diameter_km ?? v.diameter ?? 0);
        const rot = v.rotation_period_days;
        const rotation_period_days =
            rot === null || rot === undefined ? null : Number(rot);

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
