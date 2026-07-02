/** Per-planet lighting configuration — types, defaults, and merge logic. */

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
    /** Amplitude of the regional regolith<->basalt material bias (maria/terrae character). */
    regionalAmp?: number;
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
    /** Scale of the real-texture tangent-space bump (ground-detail-v1.md Step 3). 0 = pure
     *  geometric/df64 normal; 1 = the texture-authored bump at full strength. */
    normalMapStrength?: number;
    /** Physical size (metres) of one normal-map tile on the ground. Smaller = finer grain;
     *  too large makes the bump read as flat/smeared (ground-detail-v1.md Step 3). */
    normalTileM?: number;
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
    /** Diffuse normal AA: blend toward the smooth landform normal where the per-pixel shading
     *  normal varies faster than the pixel can resolve. Higher = smoother sooner (less grazing grain). */
    normalAa?: number;
    /** Mean-preserving normal-AA correction strength (uPerfMask bit5) — darkens by sub-pixel normal
     *  variance × grazing concavity so variance-smoothing does not over-brighten at grazing. */
    meanAaK?: number;
    /** Per-vertex crater-gradient footprint scale (footprintKm = camDistKm * this). Higher fades
     *  sub-leaf craters sooner so small craters do not alias to square/diamond facets at distance. */
    craterFpK?: number;
};

/**
 * Physically-based (single-scattering) atmosphere parameters. Present only on bodies that HAVE an
 * atmosphere; absent/null => airless (the atmosphere Frame Graph task is inactive for that body).
 * Coefficients are per-kilometre; defaults are Earth-like (see ATMOSPHERE_DEFAULTS).
 */
export type AtmosphereParams = {
    /** Atmosphere shell thickness above the surface, in km. */
    heightKm?: number;
    /** Rayleigh scattering coefficients per km [r, g, b]. */
    rayleigh?: [number, number, number];
    /** Rayleigh density scale height, in km. */
    rayleighScaleKm?: number;
    /** Mie scattering coefficient per km (scalar, grey). */
    mie?: number;
    /** Mie density scale height, in km. */
    mieScaleKm?: number;
    /** Mie Henyey-Greenstein asymmetry g (0..~0.9, forward-scatter sun halo). */
    mieG?: number;
    /** Sun radiance multiplier feeding the in-scattering. */
    intensity?: number;
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
    /** Single-scattering atmosphere (omit for airless bodies). */
    atmosphere?: AtmosphereParams;
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
export type ResolvedTerrain  = Required<TerrainLightingParams>;
export type ResolvedBrdf     = Required<BrdfLightingParams>;
export type ResolvedAtmosphere = Required<AtmosphereParams>;

export type ResolvedLighting = {
    albedo: [number, number, number];
    ambient: [number, number, number];
    atmoDensity: number;
    atmoColor: [number, number, number];
    /** Resolved single-scattering atmosphere, or null for airless bodies. */
    atmosphere: ResolvedAtmosphere | null;
    terrain: ResolvedTerrain;
    brdf: ResolvedBrdf;
};

/** Earth-like fallbacks for any atmosphere field a body omits. */
export const ATMOSPHERE_DEFAULTS: ResolvedAtmosphere = {
    heightKm:        100,
    rayleigh:        [5.8e-3, 13.5e-3, 33.1e-3],
    rayleighScaleKm: 8.0,
    mie:             21e-3,
    mieScaleKm:      1.2,
    mieG:            0.76,
    intensity:       20
};

/** Code-level fallbacks — values identical to the previous hardcoded constants. */
export const DEFAULT_LIGHTING: ResolvedLighting = {
    albedo:      [0.15, 0.14, 0.13],
    ambient:     [0.008, 0.008, 0.008],
    atmoDensity: 0,
    atmoColor:   [0, 0, 0],
    atmosphere:  null,
    terrain: {
        highlandTint: [1.12, 1.12, 1.16],
        slopeLo:      0.03,
        slopeHi:      0.22,
        slopeDist:    2.0,
        plainsAmp:    0.12,
        regionalAmp:  0.3
    },
    brdf: {
        lunarLs:    0.7,
        oppAmp:     0.15,
        oppCos:     0.93,
        aoStrength: 0.35,
        roughLo:    0.6,
        roughHi:    0.9,
        normalMapStrength: 0.6,
        normalTileM: 1.0,
        f0:         0.04,
        specAa:     0.5,
        specMax:    4.0,
        normalAa:   12.0,
        meanAaK:    0.18,
        craterFpK:  0.002
    }
};

/** Resolve an atmosphere block (or null if the body has none), filling gaps from ATMOSPHERE_DEFAULTS. */
function resolveAtmosphere(a: AtmosphereParams | undefined): ResolvedAtmosphere | null {
    if (!a) return null;
    const A = ATMOSPHERE_DEFAULTS;
    return {
        heightKm:        a.heightKm        ?? A.heightKm,
        rayleigh:        a.rayleigh        ?? A.rayleigh,
        rayleighScaleKm: a.rayleighScaleKm ?? A.rayleighScaleKm,
        mie:             a.mie             ?? A.mie,
        mieScaleKm:      a.mieScaleKm      ?? A.mieScaleKm,
        mieG:            a.mieG            ?? A.mieG,
        intensity:       a.intensity       ?? A.intensity
    };
}

/**
 * Resolve lighting params for a planet.
 * Merge order: per-planet override (from data.json) → _defaults (from planet_lighting.json) → DEFAULT_LIGHTING.
 */
export function resolveLighting(json: PlanetLightingJSON, override?: PlanetLightingParams): ResolvedLighting {
    const d = json._defaults ?? {};
    const o = override ?? {};
    const dt = d.terrain  ?? {};
    const db = d.brdf     ?? {};
    const ot = o.terrain  ?? {};
    const ob = o.brdf     ?? {};
    const D = DEFAULT_LIGHTING;

    return {
        albedo:      o.albedo      ?? d.albedo      ?? D.albedo,
        ambient:     o.ambient     ?? d.ambient     ?? D.ambient,
        atmoDensity: o.atmoDensity ?? d.atmoDensity ?? D.atmoDensity,
        atmoColor:   o.atmoColor   ?? d.atmoColor   ?? D.atmoColor,
        atmosphere:  resolveAtmosphere(o.atmosphere ?? d.atmosphere),
        terrain: {
            highlandTint: ot.highlandTint ?? dt.highlandTint ?? D.terrain.highlandTint,
            slopeLo:      ot.slopeLo      ?? dt.slopeLo      ?? D.terrain.slopeLo,
            slopeHi:      ot.slopeHi      ?? dt.slopeHi      ?? D.terrain.slopeHi,
            slopeDist:    ot.slopeDist    ?? dt.slopeDist    ?? D.terrain.slopeDist,
            plainsAmp:    ot.plainsAmp    ?? dt.plainsAmp    ?? D.terrain.plainsAmp,
            regionalAmp:  ot.regionalAmp  ?? dt.regionalAmp  ?? D.terrain.regionalAmp
        },
        brdf: {
            lunarLs:    ob.lunarLs    ?? db.lunarLs    ?? D.brdf.lunarLs,
            oppAmp:     ob.oppAmp     ?? db.oppAmp     ?? D.brdf.oppAmp,
            oppCos:     ob.oppCos     ?? db.oppCos     ?? D.brdf.oppCos,
            aoStrength: ob.aoStrength ?? db.aoStrength ?? D.brdf.aoStrength,
            roughLo:    ob.roughLo    ?? db.roughLo    ?? D.brdf.roughLo,
            roughHi:    ob.roughHi    ?? db.roughHi    ?? D.brdf.roughHi,
            normalMapStrength: ob.normalMapStrength ?? db.normalMapStrength ?? D.brdf.normalMapStrength,
            normalTileM: ob.normalTileM ?? db.normalTileM ?? D.brdf.normalTileM,
            f0:         ob.f0         ?? db.f0         ?? D.brdf.f0,
            specAa:     ob.specAa     ?? db.specAa     ?? D.brdf.specAa,
            specMax:    ob.specMax    ?? db.specMax    ?? D.brdf.specMax,
            normalAa:   ob.normalAa   ?? db.normalAa   ?? D.brdf.normalAa,
            meanAaK:    ob.meanAaK    ?? db.meanAaK    ?? D.brdf.meanAaK,
            craterFpK:  ob.craterFpK  ?? db.craterFpK  ?? D.brdf.craterFpK
        }
    };
}
