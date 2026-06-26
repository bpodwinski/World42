/** Per-planet lighting configuration — types, defaults, and merge logic. */

export type GroundLightingParams = {
    /** Camera distance (km) at which the df64 ground detail fades in. */
    onKm?: number;
    /** Camera distance (km) at which the df64 ground detail fades out. */
    offKm?: number;
    /** Normal-tilt amplitude for the micro-relief octaves near the ground. */
    strength?: number;
    /** Number of high-frequency octaves added near the ground (df64 path). */
    octaves?: number;
};

export type TerrainLightingParams = {
    /** RGB multiplier applied at high altitude (values > 1 brighten a channel). */
    highlandTint?: [number, number, number];
    /** Slope threshold (1 - dot(landformNormal, up)) at which rock blend starts. */
    slopeLo?: number;
    /** Slope threshold at which rock blend ends. */
    slopeHi?: number;
    /** Camera distance (km) for the smooth landform normal used in slope splatting. */
    slopeDist?: number;
    /** Amplitude of the broad continental brightness variation. */
    plainsAmp?: number;
};

export type BrdfLightingParams = {
    /** Lambert (0) ↔ Lommel-Seeliger (1) blend for the diffuse BRDF. */
    lunarLs?: number;
    /** Opposition surge amplitude (hotspot at low phase angle). */
    oppAmp?: number;
    /** Opposition surge cosine threshold (cos of max phase angle for the surge). */
    oppCos?: number;
    /** Curvature AO strength (0 = no AO, 1 = full black in concavities). */
    aoStrength?: number;
    /** Cook-Torrance roughness on flat terrain. */
    roughLo?: number;
    /** Cook-Torrance roughness on steep slopes. */
    roughHi?: number;
    /**
     * Fresnel reflectance at normal incidence.
     * Physical range [0.02, 0.07] for geological/icy materials:
     * 0.04 = silicate rock/regolith, 0.022 = water-ice, 0.055 = sulfur.
     */
    f0?: number;
    /** Geometric specular AA variance scale (Kaplanyan). Higher = softer highlights. */
    specAa?: number;
    /** Firefly clamp on the specular term. */
    specMax?: number;
};

export type PlanetLightingParams = {
    /** Base surface albedo [r, g, b] in linear space. */
    albedo?: [number, number, number];
    /** Ambient light level [r, g, b] in linear space. */
    ambient?: [number, number, number];
    /** Aerial fog density. 0 = disabled (use for planets with full atmosphere post-process). */
    atmoDensity?: number;
    /** Aerial fog target color [r, g, b] in linear space. */
    atmoColor?: [number, number, number];
    ground?: GroundLightingParams;
    terrain?: TerrainLightingParams;
    brdf?: BrdfLightingParams;
};

/**
 * Schema for planet_lighting.json.
 * Contains only `_defaults` — per-planet overrides live in data.json `lighting` blocks.
 */
export type PlanetLightingJSON = {
    _defaults: PlanetLightingParams;
};

/** Fully resolved lighting — all fields present (no optionals). Passed to bakedHeader(). */
export type ResolvedGround   = Required<GroundLightingParams>;
export type ResolvedTerrain  = Required<TerrainLightingParams>;
export type ResolvedBrdf     = Required<BrdfLightingParams>;

export type ResolvedLighting = {
    albedo: [number, number, number];
    ambient: [number, number, number];
    atmoDensity: number;
    atmoColor: [number, number, number];
    ground: ResolvedGround;
    terrain: ResolvedTerrain;
    brdf: ResolvedBrdf;
};

/** Code-level fallbacks — values identical to the previous hardcoded constants. */
export const DEFAULT_LIGHTING: ResolvedLighting = {
    albedo:      [0.15, 0.14, 0.13],
    ambient:     [0.008, 0.008, 0.008],
    atmoDensity: 0,
    atmoColor:   [0, 0, 0],
    ground: {
        onKm:     0.05,
        offKm:    0.15,
        strength: 0.03,
        octaves:  4
    },
    terrain: {
        highlandTint: [1.12, 1.12, 1.16],
        slopeLo:      0.03,
        slopeHi:      0.22,
        slopeDist:    2.0,
        plainsAmp:    0.12
    },
    brdf: {
        lunarLs:    0.7,
        oppAmp:     0.15,
        oppCos:     0.93,
        aoStrength: 0.35,
        roughLo:    0.6,
        roughHi:    0.9,
        f0:         0.04,
        specAa:     0.5,
        specMax:    4.0
    }
};

/**
 * Resolve lighting params for a planet.
 * Merge order: per-planet override (from data.json) → _defaults (from planet_lighting.json) → DEFAULT_LIGHTING.
 */
export function resolveLighting(json: PlanetLightingJSON, override?: PlanetLightingParams): ResolvedLighting {
    const d = json._defaults ?? {};
    const o = override ?? {};
    const dg = d.ground   ?? {};
    const dt = d.terrain  ?? {};
    const db = d.brdf     ?? {};
    const og = o.ground   ?? {};
    const ot = o.terrain  ?? {};
    const ob = o.brdf     ?? {};
    const D = DEFAULT_LIGHTING;

    return {
        albedo:      o.albedo      ?? d.albedo      ?? D.albedo,
        ambient:     o.ambient     ?? d.ambient     ?? D.ambient,
        atmoDensity: o.atmoDensity ?? d.atmoDensity ?? D.atmoDensity,
        atmoColor:   o.atmoColor   ?? d.atmoColor   ?? D.atmoColor,
        ground: {
            onKm:     og.onKm     ?? dg.onKm     ?? D.ground.onKm,
            offKm:    og.offKm    ?? dg.offKm    ?? D.ground.offKm,
            strength: og.strength ?? dg.strength ?? D.ground.strength,
            octaves:  og.octaves  ?? dg.octaves  ?? D.ground.octaves
        },
        terrain: {
            highlandTint: ot.highlandTint ?? dt.highlandTint ?? D.terrain.highlandTint,
            slopeLo:      ot.slopeLo      ?? dt.slopeLo      ?? D.terrain.slopeLo,
            slopeHi:      ot.slopeHi      ?? dt.slopeHi      ?? D.terrain.slopeHi,
            slopeDist:    ot.slopeDist    ?? dt.slopeDist    ?? D.terrain.slopeDist,
            plainsAmp:    ot.plainsAmp    ?? dt.plainsAmp    ?? D.terrain.plainsAmp
        },
        brdf: {
            lunarLs:    ob.lunarLs    ?? db.lunarLs    ?? D.brdf.lunarLs,
            oppAmp:     ob.oppAmp     ?? db.oppAmp     ?? D.brdf.oppAmp,
            oppCos:     ob.oppCos     ?? db.oppCos     ?? D.brdf.oppCos,
            aoStrength: ob.aoStrength ?? db.aoStrength ?? D.brdf.aoStrength,
            roughLo:    ob.roughLo    ?? db.roughLo    ?? D.brdf.roughLo,
            roughHi:    ob.roughHi    ?? db.roughHi    ?? D.brdf.roughHi,
            f0:         ob.f0         ?? db.f0         ?? D.brdf.f0,
            specAa:     ob.specAa     ?? db.specAa     ?? D.brdf.specAa,
            specMax:    ob.specMax    ?? db.specMax    ?? D.brdf.specMax
        }
    };
}
