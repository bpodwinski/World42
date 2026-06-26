import {
    Scene,
    Vector3,
    MeshBuilder,
    PBRMetallicRoughnessMaterial,
    Color3,
    TransformNode,
    WebGPUEngine,
} from "@babylonjs/core";

import { FloatingEntity, OriginCamera } from "../../core/camera/camera_manager";
import { ScaleManager } from "../../core/scale/scale_manager";
import { TextureManager } from "../../core/io/texture_manager";
import { CbtPlanet } from "../../systems/lod/cbt/cbt_scheduler";
import type { NoiseParams } from "../../systems/lod/cbt/cbt_noise";
import {
    normalizeCatalogJSON as normalizeCatalogJSONFromSource,
    normalizeSystemJSON,
} from "./stellar_catalog_normalizer";
import lightingJsonRaw from "./planet_lighting.json";
import { resolveLighting, type PlanetLightingJSON, type PlanetLightingParams } from "./planet_lighting";

const LIGHTING_JSON = lightingJsonRaw as unknown as PlanetLightingJSON;

/** ---------- Types JSON (catalogue) ---------- */
export type StarJSON = {
    temperature_k?: number;
    color_rgb?: [number, number, number]; // linéaire 0..1
    intensity?: number;
};

export type BodyJSON = {
    type: string;
    position_km: [number, number, number];
    diameter_km: number;
    rotation_period_days: number | null;
    star?: StarJSON;
    /** Per-planet lighting overrides — merged with planet_lighting.json `_defaults`. */
    lighting?: PlanetLightingParams;
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

/**
 * Runtime representation of a loaded celestial body.
 *
 * Coordinate space conventions:
 * - `positionWorldDouble`: **WorldDouble** (simulation units, high-precision absolute position)
 * - `diameterSim` / `radiusSim`: **Simulation units** (km * SCALE_FACTOR)
 * - `node`: **Render-space** transform (parented under FloatingEntity)
 */
export type LoadedBody = {
    systemId: string;
    bodyType: string;
    name: string;

    /** Pivot in render-space (rotation/tilt), parented under FloatingEntity. */
    node: TransformNode;

    meshName: string;

    /** Absolute position in WorldDouble (simulation units). */
    positionWorldDouble: Vector3;

    /** Full diameter in simulation units (converted from diameter_km via ScaleManager). */
    diameterSim: number;

    /** Half-diameter (radius) in simulation units. Convenience = diameterSim * 0.5. */
    radiusSim: number;

    rotationPeriodDays: number | null;

    entity?: FloatingEntity;

    starLight?: {
        color: Vector3;      // (r,g,b) linéaire
        intensity: number;   // scalaire
    };

    /** Lighting overrides from data.json, forwarded to resolveLighting(). */
    lighting?: PlanetLightingParams;
};

export type LoadedSystem = {
    systemId: string;
    root: TransformNode; // sys_<systemId>
    bodies: Map<string, LoadedBody>;
};

export type PlanetCBT = {
    entity: FloatingEntity;
    runtime: CbtPlanet;
    /** Planet radius in simulation units. */
    radiusSim: number;
    /** Star position in WorldDouble used for terrain lighting. */
    starPosWorldDouble: Vector3 | null;
};

export type CBTOptions = {
    /** Noise field (CPU displacement + GPU shader); default DEFAULT_NOISE. */
    noise?: NoiseParams;
    engine?: WebGPUEngine;
    skip?: (name: string, body: LoadedBody) => boolean;
};

export type LoadSystemOptions = {
    parent?: TransformNode;
    animateRotation?: boolean;
    makeMaterial?: (name: string, isStar: boolean, scene: Scene) => PBRMetallicRoughnessMaterial;
};

/** ---------- API ---------- */
/** Liste des systèmes disponibles (compat ancien format inclus). */
export function listStellarSystems(jsonSource: unknown): string[] {
    const cat = normalizeCatalogJSONFromSource(jsonSource);
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

    const catalog = normalizeCatalogJSONFromSource(jsonSource);
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
        const type = data.type;
        const isStar = type === "star";

        const pivot = new TransformNode(`pivot_${systemId}_${name}`, scene);
        pivot.parent = root;
        pivot.position.set(0, 0, 0);

        const pKm = data.position_km;
        const posWorldDouble = originWorldDouble.add(
            ScaleManager.toSimulationVector(new Vector3(pKm[0], pKm[1], pKm[2]))
        );

        let meshName = `body_${systemId}_${name}`;

        const diameterSim = ScaleManager.toSimulationUnits(data.diameter_km);

        const starLight = isStar ? parseStarLight(data.star) : undefined;

        if (isStar) {
            const sphere = MeshBuilder.CreateSphere(meshName, { diameter: diameterSim, segments: 64 }, scene);
            sphere.parent = pivot;

            const mat = makeMaterial(`${systemId}_${name}`, true, scene);

            // ✅ applique la couleur/intensité JSON sur l’étoile
            if (starLight) {
                mat.emissiveColor = new Color3(starLight.color.x, starLight.color.y, starLight.color.z);
            }
            sphere.material = mat;
            meshName = sphere.name;
        }

        bodies.set(name, {
            systemId,
            bodyType: type,
            name,
            node: pivot,
            meshName,
            positionWorldDouble: posWorldDouble,
            diameterSim,
            radiusSim: diameterSim * 0.5,
            rotationPeriodDays: data.rotation_period_days,
            starLight,
            lighting: data.lighting,
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

export function createCBTForSystem(
    scene: Scene,
    camera: OriginCamera,
    loaded: LoadedSystem,
    opts: CBTOptions = {}
): Map<string, PlanetCBT> {
    const {
        noise,
        engine,
        skip = (_name: string, body: LoadedBody) => body.bodyType === "star",
    } = opts;

    for (const [name, body] of loaded.bodies) {
        if (!body.entity) {
            const ent = new FloatingEntity(`ent_${loaded.systemId}_${name}`, scene);
            ent.parent = loaded.root;
            ent.doublepos.copyFrom(body.positionWorldDouble);
            camera.add(ent);

            body.node.parent = ent;
            body.node.position.set(0, 0, 0);
            body.entity = ent;
        }
    }

    const out = new Map<string, PlanetCBT>();
    const stars = Array.from(loaded.bodies.values()).filter((b) => b.bodyType === "star");

    for (const [name, body] of loaded.bodies) {
        if (skip(name, body)) continue;

        const { pos: starPosWorldDouble, color: starColor, intensity: starIntensity, name: starName } =
            pickNearestStar(body, stars);

        const ent = body.entity!;
        const planetKey = `${loaded.systemId}:${name}`;
        const runtime = new CbtPlanet(scene, camera, {
            key: planetKey,
            entity: ent,
            renderParent: body.node,
            radiusSim: body.radiusSim,
            noise,
            starPosWorldDouble,
            starColor,
            starIntensity,
            lighting: resolveLighting(LIGHTING_JSON, body.lighting),
        });

        console.log(
            `[light][cbt] ${planetKey} -> ${starName} color=${starColor.toString()} I=${starIntensity}`
        );

        out.set(name, {
            entity: ent,
            runtime,
            radiusSim: body.radiusSim,
            starPosWorldDouble,
        });
    }

    return out;
}

/** ---------- Star helpers ---------- */
function parseStarLight(star?: StarJSON): { color: Vector3; intensity: number } {
    const intensity = Number.isFinite(star?.intensity) ? (star!.intensity as number) : 1.0;

    if (star?.color_rgb) {
        const [r, g, b] = star.color_rgb;
        return {
            color: new Vector3(r, g, b),
            intensity,
        };
    }

    if (typeof star?.temperature_k === "number") {
        return {
            color: kelvinToLinearRGB(star.temperature_k),
            intensity,
        };
    }

    return { color: new Vector3(1, 1, 1), intensity };
}

function kelvinToLinearRGB(k: number): Vector3 {
    // Approx Tanner Helland (sRGB), puis on approx linéaire par pow(2.2)
    const t = Math.max(1000, Math.min(40000, k)) / 100;
    let r = 0, g = 0, b = 0;

    // R
    if (t <= 66) r = 255;
    else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);

    // G
    if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
    else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);

    // B
    if (t >= 66) b = 255;
    else if (t <= 19) b = 0;
    else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

    const clamp01 = (x: number) => Math.max(0, Math.min(1, x / 255));
    // sRGB -> approx linéaire
    const toLin = (x: number) => Math.pow(clamp01(x), 2.2);

    return new Vector3(toLin(r), toLin(g), toLin(b));
}

function pickNearestStar(body: LoadedBody, stars: LoadedBody[]) {
    if (!stars.length) {
        return {
            pos: null as Vector3 | null,
            color: new Vector3(1, 1, 1),
            intensity: 0.25,
            name: "none",
        };
    }

    let best = stars[0];
    let bestD2 = Vector3.DistanceSquared(body.positionWorldDouble, best.positionWorldDouble);

    for (let i = 1; i < stars.length; i++) {
        const s = stars[i];
        const d2 = Vector3.DistanceSquared(body.positionWorldDouble, s.positionWorldDouble);
        if (d2 < bestD2) {
            best = s;
            bestD2 = d2;
        }
    }

    const light = best.starLight ?? { color: new Vector3(1, 1, 1), intensity: 1.0 };
    return { pos: best.positionWorldDouble, color: light.color, intensity: light.intensity, name: best.name };
}

