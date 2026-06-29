/**
 * Persistence for terrain-profile edits made in the options menu. Overrides are stored in
 * localStorage as a flat { profileId: { dottedPath: value } } map (matching terrain_param_schema
 * paths), so they survive reloads and can be applied to the base profiles at startup. The base
 * profiles (planet_profiles.ts) are never mutated — effectiveProfile() returns a CLONE with the
 * stored overrides applied. American English only.
 */

import {
    DEFAULT_PROFILE_ID,
    PLANET_PROFILES,
    resolveProfile,
    type ResolvedProfile,
    type TerrainProfile
} from './planet_profiles';
import lightingJsonRaw from './planet_lighting.json';
import type { PlanetLightingJSON } from './planet_lighting';
import { setPath } from './terrain_param_schema';

const LIGHTING_JSON = lightingJsonRaw as unknown as PlanetLightingJSON;

const STORAGE_KEY = 'world42.terrainProfiles';

/** profileId -> (dotted param path -> value). */
export type OverrideMap = Record<string, Record<string, number>>;

/** Load all persisted overrides (empty object if none / unavailable / corrupt). */
export function loadOverrides(): OverrideMap {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
        return raw ? (JSON.parse(raw) as OverrideMap) : {};
    } catch {
        return {};
    }
}

/** Persist the whole override map. */
export function saveOverrides(map: OverrideMap): void {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
        }
    } catch {
        /* localStorage unavailable (private mode / SSR) — ignore. */
    }
}

/** Record one parameter override for a profile and persist. */
export function setOverride(profileId: string, path: string, value: number): void {
    const map = loadOverrides();
    (map[profileId] ??= {})[path] = value;
    saveOverrides(map);
}

/** Drop all overrides for a profile (menu "Reset to defaults"). */
export function clearProfileOverrides(profileId: string): void {
    const map = loadOverrides();
    delete map[profileId];
    saveOverrides(map);
}

/** Deep clone a profile (pure data — numbers/arrays/strings only). */
function cloneProfile(p: TerrainProfile): TerrainProfile {
    return JSON.parse(JSON.stringify(p)) as TerrainProfile;
}

/**
 * The base profile with persisted overrides applied — a fresh clone, safe to mutate. This is what
 * both the loader (at startup) and the menu (as its working copy) build on.
 */
export function effectiveProfile(profileId: string): TerrainProfile {
    const base = PLANET_PROFILES[profileId] ?? PLANET_PROFILES[DEFAULT_PROFILE_ID];
    const clone = cloneProfile(base);
    const ov = loadOverrides()[profileId];
    if (ov) {
        for (const [path, value] of Object.entries(ov)) {
            setPath(clone as unknown as Record<string, unknown>, path, value);
        }
    }
    return clone;
}

/**
 * Fully resolve a profile (with persisted overrides) into concrete numbers at every schema path —
 * the working object the options menu binds its sliders to (lighting is resolved, so all BRDF/ground
 * fields are present even when the profile only overrides a few).
 */
export function resolveEffectiveProfile(profileId: string): ResolvedProfile {
    return resolveProfile(LIGHTING_JSON, effectiveProfile(profileId));
}
