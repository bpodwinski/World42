/**
 * OCBT LOD / performance knobs. Drive tessellation density and the GPU pool size. Formerly hardcoded
 * in CbtPlanet.createSource; now a per-profile block (planet_profiles.ts) so the options menu can
 * tune them. Changing any of these recreates the OCBT source (new pool buffers + thresholds), so the
 * topology reconverges. Pure data — no Babylon import, so the config layer can depend on it freely.
 */

export type OcbtLodParams = {
    /** Split when a leaf's longest edge projects above this many pixels (main sharpness knob). */
    splitPx: number;
    /** Merge below this many pixels. MUST be < splitPx (hysteresis; ideally < splitPx/sqrt(2)). */
    mergePx: number;
    /** GPU pool capacity as a power of two (slots = 1 << capacityPow). Must hold the live leaf set. */
    capacityPow: number;
    /** Subdivision floor: the whole sphere is force-refined to at least this level (rounder far limb). */
    minLevel: number;
    /** Hard subdivision cap (u64 limit; df64 cracks well before ~32). */
    maxLevel: number;
};

/** Default OCBT LOD knobs (the values previously hardcoded in createSource). */
export const DEFAULT_LOD: OcbtLodParams = {
    splitPx: 16,
    mergePx: 8,
    capacityPow: 19, // 1 << 19 = 524 288 slots
    minLevel: 6,
    maxLevel: 32
};
