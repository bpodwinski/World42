/**
 * Planet terrain PROFILES — archetypes by surface TYPE (Space-Engine style), NOT per individual
 * planet. A planet (hand-authored in data.json or generated procedurally) references a profile by id
 * plus a seed: millions of procedural worlds share a handful of profiles instead of duplicating
 * parameters. A profile bundles the three terrain-shaping systems:
 *
 *   - noise    (FBM relief)        -> cbt_noise.ts NoiseParams        (GPU bake + CPU collision)
 *   - craters  (impact geometry)   -> cbt_noise.ts CraterParams       (GPU bake + CPU collision)
 *   - lighting (BRDF / albedo / …) -> planet_lighting.ts (resolved over planet_lighting.json)
 *
 * This is the SOURCE the in-game options menu edits (see terrain_param_schema.ts). Comments here
 * explain each profile's intent; per-parameter docs/ranges live in the schema. American English only.
 */

import {
    DEFAULT_CRATERS,
    DEFAULT_NOISE,
    type CraterParams,
    type NoiseParams
} from '../../systems/lod/cbt/cbt_noise';
import {
    resolveLighting,
    type PlanetLightingJSON,
    type PlanetLightingParams,
    type ResolvedLighting
} from './planet_lighting';

/** A terrain archetype. `lighting` is an override merged over planet_lighting.json `_defaults`. */
export type TerrainProfile = {
    /** Human-readable name shown in the options menu. */
    label: string;
    /** One-line description of the archetype (menu tooltip). */
    description: string;
    noise: NoiseParams;
    craters: CraterParams;
    /** Optional lighting override; omitted fields fall back to planet_lighting.json `_defaults`. */
    lighting?: PlanetLightingParams;
};

/** A fully resolved profile, ready to hand to a CbtPlanet (noise + craters + resolved lighting). */
export type ResolvedProfile = {
    noise: NoiseParams;
    craters: CraterParams;
    lighting: ResolvedLighting;
};

/** Default profile when a body names none / an unknown id. Reproduces the current Moon look. */
export const DEFAULT_PROFILE_ID = 'selena';

/**
 * The profile registry. `selena` is the canonical truth (== DEFAULT_NOISE + DEFAULT_CRATERS +
 * planet_lighting `_defaults`), so a body set to `selena` renders bit-for-bit like today's Moon.
 * The other profiles are sensible STARTER archetypes — tune them live via the options menu.
 */
export const PLANET_PROFILES: Record<string, TerrainProfile> = {
    // --- Airless rocky (Moon / Mercury): craters are the dominant relief, no atmosphere. ----------
    // The pilot/dev archetype. Values mirror the engine defaults exactly.
    selena: {
        label: 'Selena (airless rocky)',
        description: 'Moon/Mercury: crater-dominated regolith, no atmosphere. The reference look.',
        noise: { ...DEFAULT_NOISE },
        craters: { ...DEFAULT_CRATERS },
        // The dev Moon's tuned look (moved here from data.json so the options menu governs it).
        lighting: {
            albedo: [0.07, 0.07, 0.07],
            ambient: [0.003, 0.003, 0.003],
            terrain: { highlandTint: [1.08, 1.06, 1.02], plainsAmp: 0.06 },
            brdf: { lunarLs: 0.9, oppAmp: 0.28, aoStrength: 0.5 }
        }
    },

    // --- Desert (Mars-like): eroded, fewer fresh craters, reddish dust, more inter-crater relief. -
    mars: {
        label: 'Mars (desert)',
        description: 'Eroded cratered highlands + dunes, reddish dust, few fresh ray systems.',
        noise: { ...DEFAULT_NOISE, globalAmplitude: 6, baseFrequency: 6.0 },
        craters: {
            ...DEFAULT_CRATERS,
            scale: 0.8, // shallower (infilled / eroded)
            rimIrregularity: 0.34, // lumpier worn rims
            rimFrequency: 3.0,
            freshFraction: 0.05, // few bright fresh craters
            rayClasses: 1,
            classes: [
                [750, 0.2, 14.0, 0.5],
                [220, 0.2, 5.0, 0.6],
                [70, 0.2, 1.8, 0.7],
                [20, 0.2, 0.6, 0.8],
                [6, 0.2, 0.22, 0.82],
                [2, 0.2, 0.09, 0.85]
            ]
        },
        lighting: {
            albedo: [0.18, 0.1, 0.06],
            brdf: { lunarLs: 0.4 }
        }
    },

    // --- Terrestrial (Earth-like): mountains from FBM, craters almost erased by erosion. -----------
    terra: {
        label: 'Terra (terrestrial)',
        description: 'Strong FBM mountains/continents; impact craters nearly erased by erosion.',
        noise: { ...DEFAULT_NOISE, globalAmplitude: 9, baseFrequency: 4.5, persistence: 0.52 },
        craters: {
            ...DEFAULT_CRATERS,
            scale: 0.3,
            freshFraction: 0.0,
            rayClasses: 0,
            classes: [
                [750, 0.2, 6.0, 0.15],
                [220, 0.2, 2.0, 0.18],
                [70, 0.2, 0.6, 0.2]
            ]
        },
        lighting: {
            albedo: [0.08, 0.1, 0.07],
            brdf: { lunarLs: 0.2 }
        }
    },

    // --- Icy (Europa-like): bright fractured crust, high-frequency ridges, sparse craters. ---------
    ice: {
        label: 'Ice (icy crust)',
        description: 'Bright fractured ice crust, high-frequency ridges, sparse bright craters.',
        noise: { ...DEFAULT_NOISE, globalAmplitude: 4, baseFrequency: 7.0, detailOctaves: 18 },
        craters: {
            ...DEFAULT_CRATERS,
            scale: 0.6,
            freshFraction: 0.25, // bright on bright ice
            classes: [
                [750, 0.2, 8.0, 0.35],
                [220, 0.2, 3.0, 0.4],
                [70, 0.2, 1.2, 0.5],
                [20, 0.2, 0.5, 0.6],
                [6, 0.2, 0.2, 0.7]
            ]
        },
        lighting: {
            albedo: [0.6, 0.62, 0.66],
            brdf: { lunarLs: 0.5, roughLo: 0.4, roughHi: 0.8 }
        }
    },

    // --- Volcanic (lava world): dark basalt, rough sharp relief, calderas, resurfaced (few craters).
    lava: {
        label: 'Lava (volcanic)',
        description: 'Dark basalt, rough sharp relief, calderas; impact craters resurfaced away.',
        noise: { ...DEFAULT_NOISE, globalAmplitude: 7, baseFrequency: 6.5, baseAmplitude: 40, persistence: 0.55 },
        craters: {
            ...DEFAULT_CRATERS,
            scale: 0.5,
            freshFraction: 0.0,
            rayClasses: 0,
            classes: [
                [750, 0.18, 10.0, 0.3], // big calderas
                [220, 0.18, 3.5, 0.35],
                [70, 0.2, 1.0, 0.4]
            ]
        },
        lighting: {
            albedo: [0.04, 0.035, 0.03],
            brdf: { lunarLs: 0.5 }
        }
    }
};

/** Ordered list of profile ids for the menu dropdown. */
export const PROFILE_IDS = Object.keys(PLANET_PROFILES);

/** Shallow-merge two optional records (over wins); used for one-level lighting sub-objects. */
function mergeObj<T extends object>(base?: T, over?: T): T | undefined {
    if (!base) return over;
    if (!over) return base;
    return { ...base, ...over };
}

/** Merge a per-body lighting override on top of a profile's lighting (one level deep). */
function mergeLightingParams(
    base?: PlanetLightingParams,
    over?: PlanetLightingParams
): PlanetLightingParams | undefined {
    if (!base) return over;
    if (!over) return base;
    return {
        ...base,
        ...over,
        atmosphere: mergeObj(base.atmosphere, over.atmosphere),
        ground: mergeObj(base.ground, over.ground),
        terrain: mergeObj(base.terrain, over.terrain),
        brdf: mergeObj(base.brdf, over.brdf)
    };
}

/**
 * Resolve a profile id into concrete terrain params for a CbtPlanet.
 * @param json planet_lighting.json (provides the lighting `_defaults`).
 * @param profileId profile to resolve (falls back to {@link DEFAULT_PROFILE_ID}).
 * @param opts.seed overrides the noise seed (per-planet uniqueness for procedural worlds).
 * @param opts.lightingOverride per-body fine override merged over the profile's lighting.
 */
export function resolveProfile(
    json: PlanetLightingJSON,
    profileOrId: string | TerrainProfile,
    opts?: { seed?: number; lightingOverride?: PlanetLightingParams }
): ResolvedProfile {
    const p =
        typeof profileOrId === 'string'
            ? PLANET_PROFILES[profileOrId] ?? PLANET_PROFILES[DEFAULT_PROFILE_ID]
            : profileOrId;
    const noise: NoiseParams = { ...p.noise };
    if (opts?.seed !== undefined) noise.seed = opts.seed;
    const lighting = resolveLighting(json, mergeLightingParams(p.lighting, opts?.lightingOverride));
    return { noise, craters: { ...p.craters, classes: p.craters.classes.map((c) => [...c] as const) }, lighting };
}
