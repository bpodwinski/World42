/**
 * Editable-parameter SCHEMA for the terrain options menu. The menu (core/gui/terrain_options_menu.ts)
 * walks this list to auto-generate folders + sliders — adding a tunable means adding ONE entry here,
 * not touching UI code. Each entry documents the parameter (the explanatory comments the user asked
 * for) and declares its range and whether it is `baked` (compiled into the WGSL header -> needs a
 * material/planet rebuild to take effect) or `uniform` (a runtime uniform -> can apply live).
 *
 * `path` is a dotted path into a working profile object { noise, craters, lighting }, addressed via
 * getPath/setPath below. American English only.
 */

/** baked = needs a rebuild to take effect; uniform = a runtime uniform (can apply live). */
export type ParamKind = 'baked' | 'uniform';

export type ParamSpec = {
    /** Dotted path into the working profile, e.g. 'noise.globalAmplitude', 'lighting.brdf.lunarLs'. */
    path: string;
    /** Menu folder this parameter is grouped under. */
    group: string;
    /** Slider label. */
    label: string;
    /** One-line explanation (menu tooltip / inline help). */
    description: string;
    min: number;
    max: number;
    step: number;
    /** Integer slider (octave counts, class counts, seed). */
    int?: boolean;
    kind: ParamKind;
};

export const TERRAIN_PARAM_SCHEMA: ParamSpec[] = [
    // --- Relief (FBM noise) -- all baked into the noise header (GPU) and read by CPU collision. -----
    { path: 'noise.globalAmplitude', group: 'Relief', label: 'Relief height (km)', kind: 'baked',
      min: 0, max: 40, step: 0.5, description: 'Overall FBM relief amplitude in km (the inter-crater roughness scale).' },
    { path: 'noise.baseFrequency', group: 'Relief', label: 'Base frequency', kind: 'baked',
      min: 0.5, max: 16, step: 0.1, description: 'First octave frequency. Lower = larger landforms.' },
    { path: 'noise.baseAmplitude', group: 'Relief', label: 'Base amplitude', kind: 'baked',
      min: 1, max: 64, step: 1, description: 'First octave weight before normalization (relative).' },
    { path: 'noise.octaves', group: 'Relief', label: 'Macro octaves', kind: 'baked', int: true,
      min: 1, max: 16, step: 1, description: 'Number of macro FBM octaves (richness). GPU caps the cascade at 12.' },
    { path: 'noise.detailOctaves', group: 'Relief', label: 'Detail octaves', kind: 'baked', int: true,
      min: 0, max: 18, step: 1, description: 'Extra near-ground detail octaves that fade in on approach.' },
    { path: 'noise.lacunarity', group: 'Relief', label: 'Lacunarity', kind: 'baked',
      min: 1.5, max: 3, step: 0.01, description: 'Frequency multiplier per octave (gap between scales).' },
    { path: 'noise.persistence', group: 'Relief', label: 'Persistence', kind: 'baked',
      min: 0.2, max: 0.8, step: 0.01, description: 'Amplitude falloff per octave. Higher = rougher.' },
    { path: 'noise.detailRange', group: 'Relief', label: 'Detail range', kind: 'baked',
      min: 10, max: 120, step: 1, description: 'Octave Nyquist lifetime. Higher = keeps fine detail longer (more shimmer).' },
    { path: 'noise.seed', group: 'Relief', label: 'Seed', kind: 'baked', int: true,
      min: 0, max: 9999, step: 1, description: 'World seed — changes the entire noise + crater field.' },

    // --- Craters -- baked geometry shared GPU (eval + render) and CPU collision. --------------------
    { path: 'craters.scale', group: 'Craters', label: 'Depth scale', kind: 'baked',
      min: 0, max: 2, step: 0.05, description: 'Global crater depth multiplier (0 = flat, 1 = default).' },
    { path: 'craters.range', group: 'Craters', label: 'Visibility range', kind: 'baked',
      min: 10, max: 200, step: 1, description: 'Distance factor before a class fades out. Higher = craters stay visible from farther.' },
    { path: 'craters.near', group: 'Craters', label: 'Near skip', kind: 'baked',
      min: 0, max: 0.5, step: 0.01, description: 'Per-pixel normal only: skip classes much bigger than the camera distance.' },
    { path: 'craters.rimIrregularity', group: 'Craters', label: 'Rim irregularity', kind: 'baked',
      min: 0, max: 0.6, step: 0.01, description: 'How much the rim radius varies by direction (lumpiness).' },
    { path: 'craters.rimFrequency', group: 'Craters', label: 'Rim lobes', kind: 'baked',
      min: 1, max: 8, step: 0.1, description: 'Rim lobe count. Low = polygonal/lumpy, high = circular.' },
    { path: 'craters.freshFraction', group: 'Craters', label: 'Fresh fraction', kind: 'baked',
      min: 0, max: 0.5, step: 0.01, description: 'Fraction of craters that are fresh and emit bright ejecta rays.' },
    { path: 'craters.rayClasses', group: 'Craters', label: 'Ray classes', kind: 'baked', int: true,
      min: 0, max: 6, step: 1, description: 'How many of the biggest classes emit ejecta rays.' },

    // --- Lighting -- mostly baked BRDF; atmoDensity is a live uniform. ------------------------------
    { path: 'lighting.brdf.lunarLs', group: 'Lighting', label: 'Lommel-Seeliger', kind: 'baked',
      min: 0, max: 1, step: 0.01, description: '0 = Lambert (shaded ball), 1 = airless flat disc (Moon).' },
    { path: 'lighting.brdf.aoStrength', group: 'Lighting', label: 'Curvature AO', kind: 'baked',
      min: 0, max: 1, step: 0.01, description: 'Ambient occlusion from terrain curvature (crater floors/valleys).' },
    { path: 'lighting.brdf.oppAmp', group: 'Lighting', label: 'Opposition surge', kind: 'baked',
      min: 0, max: 0.6, step: 0.01, description: 'Brightness hotspot when the Sun is at the camera back.' },
    { path: 'lighting.brdf.roughLo', group: 'Lighting', label: 'Roughness (flat)', kind: 'baked',
      min: 0, max: 1, step: 0.01, description: 'Specular roughness on flat terrain.' },
    { path: 'lighting.brdf.roughHi', group: 'Lighting', label: 'Roughness (slope)', kind: 'baked',
      min: 0, max: 1, step: 0.01, description: 'Specular roughness on steep slopes.' },
    { path: 'lighting.ground.onKm', group: 'Lighting', label: 'Ground detail on (km)', kind: 'baked',
      min: 0, max: 0.5, step: 0.005, description: 'Camera distance under which near-ground df64 micro-relief is full-on.' },
    { path: 'lighting.ground.offKm', group: 'Lighting', label: 'Ground detail off (km)', kind: 'baked',
      min: 0.05, max: 2, step: 0.01, description: 'Camera distance over which near-ground micro-relief has fully faded out.' },
    { path: 'lighting.ground.strength', group: 'Lighting', label: 'Ground detail strength', kind: 'baked',
      min: 0, max: 0.2, step: 0.005, description: 'Near-ground micro-relief normal-tilt amount.' },
    { path: 'lighting.atmoDensity', group: 'Lighting', label: 'Aerial fog', kind: 'uniform',
      min: 0, max: 0.5, step: 0.001, description: 'Aerial fog density for dusty airless bodies (0 = off). Live.' }
];

/** Read a numeric value at a dotted path; returns undefined if absent / non-numeric. */
export function getPath(obj: unknown, path: string): number | undefined {
    let cur: unknown = obj;
    for (const k of path.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[k];
    }
    return typeof cur === 'number' ? cur : undefined;
}

/** Write a numeric value at a dotted path, creating intermediate objects as needed. */
export function setPath(obj: Record<string, unknown>, path: string, value: number): void {
    const keys = path.split('.');
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const next = cur[keys[i]];
        if (next == null || typeof next !== 'object') cur[keys[i]] = {};
        cur = cur[keys[i]] as Record<string, unknown>;
    }
    cur[keys[keys.length - 1]] = value;
}
