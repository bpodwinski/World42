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

/** Widget kind: a single slider, an RGB color picker (vec3 0..1), or 3 component sliders (vec3). */
export type ParamControl = 'slider' | 'color' | 'vec3';

export type ParamSpec = {
  /** Dotted path into the working profile, e.g. 'noise.globalAmplitude', 'lighting.brdf.lunarLs'. */
  path: string;
  /** Menu folder this parameter is grouped under. */
  group: string;
  /** Slider label. */
  label: string;
  /** One-line explanation (menu tooltip / inline help). */
  description: string;
  /** Widget kind (default 'slider'). 'color'/'vec3' bind a [r,g,b] array at `path`. */
  control?: ParamControl;
  /** Slider bounds (per-component for 'vec3'; ignored for 'color'). */
  min: number;
  max: number;
  step: number;
  /** Integer slider (octave counts, class counts, seed). */
  int?: boolean;
  kind: ParamKind;
};

export const TERRAIN_PARAM_SCHEMA: ParamSpec[] = [
  // --- Relief (FBM noise) -- all baked into the noise header (GPU) and read by CPU collision. -----
  {
    path: 'noise.globalAmplitude', group: 'Relief', label: 'Relief height (km)', kind: 'baked',
    min: 0, max: 40, step: 0.5, description: 'Overall FBM relief amplitude in km (the inter-crater roughness scale).'
  },
  {
    path: 'noise.baseFrequency', group: 'Relief', label: 'Base frequency', kind: 'baked',
    min: 0.5, max: 16, step: 0.1, description: 'First octave frequency. Lower = larger landforms.'
  },
  {
    path: 'noise.baseAmplitude', group: 'Relief', label: 'Base amplitude', kind: 'baked',
    min: 1, max: 64, step: 1, description: 'First octave weight before normalization (relative).'
  },
  {
    path: 'noise.octaves', group: 'Relief', label: 'Macro octaves', kind: 'baked', int: true,
    min: 1, max: 16, step: 1, description: 'Number of macro FBM octaves (richness). GPU caps the cascade at 12.'
  },
  {
    path: 'noise.detailOctaves', group: 'Relief', label: 'Detail octaves', kind: 'baked', int: true,
    min: 0, max: 18, step: 1, description: 'Extra near-ground detail octaves that fade in on approach.'
  },
  {
    path: 'noise.lacunarity', group: 'Relief', label: 'Lacunarity', kind: 'baked',
    min: 1.5, max: 3, step: 0.01, description: 'Frequency multiplier per octave (gap between scales).'
  },
  {
    path: 'noise.persistence', group: 'Relief', label: 'Persistence', kind: 'baked',
    min: 0.2, max: 0.8, step: 0.01, description: 'Amplitude falloff per octave. Higher = rougher.'
  },
  {
    path: 'noise.detailRange', group: 'Relief', label: 'Detail range', kind: 'baked',
    min: 10, max: 120, step: 1, description: 'Octave Nyquist lifetime. Higher = keeps fine detail longer (more shimmer).'
  },
  {
    path: 'noise.seed', group: 'Relief', label: 'Seed', kind: 'baked', int: true,
    min: 0, max: 9999, step: 1, description: 'World seed — changes the entire noise + crater field.'
  },

  // --- Craters -- baked geometry shared GPU (eval + render) and CPU collision. --------------------
  {
    path: 'craters.scale', group: 'Craters', label: 'Depth scale', kind: 'baked',
    min: 0, max: 2, step: 0.05, description: 'Global crater depth multiplier (0 = flat, 1 = default).'
  },
  {
    path: 'craters.range', group: 'Craters', label: 'Visibility range', kind: 'baked',
    min: 10, max: 200, step: 1, description: 'Distance factor before a class fades out. Higher = craters stay visible from farther.'
  },
  {
    path: 'craters.near', group: 'Craters', label: 'Near skip', kind: 'baked',
    min: 0, max: 0.5, step: 0.01, description: 'Per-pixel normal only: skip classes much bigger than the camera distance.'
  },
  {
    path: 'craters.rimIrregularity', group: 'Craters', label: 'Rim irregularity', kind: 'baked',
    min: 0, max: 0.6, step: 0.01, description: 'How much the rim radius varies by direction (lumpiness).'
  },
  {
    path: 'craters.rimFrequency', group: 'Craters', label: 'Rim lobes', kind: 'baked',
    min: 1, max: 8, step: 0.1, description: 'Rim lobe count. Low = polygonal/lumpy, high = circular.'
  },
  {
    path: 'craters.freshFraction', group: 'Craters', label: 'Fresh fraction', kind: 'baked',
    min: 0, max: 0.5, step: 0.01, description: 'Fraction of craters that are fresh and emit bright ejecta rays.'
  },
  {
    path: 'craters.rayClasses', group: 'Craters', label: 'Ray classes', kind: 'baked', int: true,
    min: 0, max: 6, step: 1, description: 'How many of the biggest classes emit ejecta rays.'
  },

  // --- Colors (vec3, baked). albedo/ambient/fog are 0..1 RGB pickers; highlandTint is a >1 tint. ---
  {
    path: 'lighting.albedo', group: 'Colors', label: 'Albedo', kind: 'baked', control: 'color',
    min: 0, max: 1, step: 0.01, description: 'Base surface reflectance (linear RGB). The single most visible look knob.'
  },
  {
    path: 'lighting.ambient', group: 'Colors', label: 'Ambient', kind: 'baked', control: 'color',
    min: 0, max: 1, step: 0.001, description: 'Ambient fill light (linear RGB). Lifts the night side / shadows.'
  },
  {
    path: 'lighting.atmoColor', group: 'Colors', label: 'Fog color', kind: 'baked', control: 'color',
    min: 0, max: 1, step: 0.01, description: 'Aerial-fog target color (linear RGB). Only visible when Aerial fog > 0.'
  },
  {
    path: 'lighting.terrain.highlandTint', group: 'Colors', label: 'Highland tint', kind: 'baked', control: 'vec3',
    min: 0.5, max: 2, step: 0.01, description: 'Per-channel brightness multiplier at altitude (>1 brightens that channel).'
  },

  // --- Material splatting (slope/altitude -> rock vs regolith). All baked. ------------------------
  {
    path: 'lighting.terrain.slopeLo', group: 'Material', label: 'Slope start', kind: 'baked',
    min: 0, max: 0.5, step: 0.005, description: 'Slope (1-N·up) where rock begins to show over regolith.'
  },
  {
    path: 'lighting.terrain.slopeHi', group: 'Material', label: 'Slope full', kind: 'baked',
    min: 0, max: 1, step: 0.01, description: 'Slope where the surface is fully rock.'
  },
  {
    path: 'lighting.terrain.slopeDist', group: 'Material', label: 'Slope distance (km)', kind: 'baked',
    min: 0.1, max: 10, step: 0.1, description: 'Camera distance of the smooth normal used for slope splatting (fades micro-bumps).'
  },
  {
    path: 'lighting.terrain.plainsAmp', group: 'Material', label: 'Plains variation', kind: 'baked',
    min: 0, max: 0.5, step: 0.01, description: 'Amplitude of the broad continental brightness variation.'
  },

  // --- Lighting -- mostly baked BRDF; atmoDensity is a live uniform. ------------------------------
  {
    path: 'lighting.brdf.lunarLs', group: 'Lighting', label: 'Lommel-Seeliger', kind: 'baked',
    min: 0, max: 1, step: 0.01, description: '0 = Lambert (shaded ball), 1 = airless flat disc (Moon).'
  },
  {
    path: 'lighting.brdf.aoStrength', group: 'Lighting', label: 'Curvature AO', kind: 'baked',
    min: 0, max: 1, step: 0.01, description: 'Ambient occlusion from terrain curvature (crater floors/valleys).'
  },
  {
    path: 'lighting.brdf.oppAmp', group: 'Lighting', label: 'Opposition surge', kind: 'baked',
    min: 0, max: 0.6, step: 0.01, description: 'Brightness hotspot when the Sun is at the camera back.'
  },
  {
    path: 'lighting.brdf.roughLo', group: 'Lighting', label: 'Roughness (flat)', kind: 'baked',
    min: 0, max: 1, step: 0.01, description: 'Specular roughness on flat terrain.'
  },
  {
    path: 'lighting.brdf.roughHi', group: 'Lighting', label: 'Roughness (slope)', kind: 'baked',
    min: 0, max: 1, step: 0.01, description: 'Specular roughness on steep slopes.'
  },
  {
    path: 'lighting.ground.onKm', group: 'Lighting', label: 'Ground detail on (km)', kind: 'baked',
    min: 0, max: 0.5, step: 0.005, description: 'Camera distance under which near-ground df64 micro-relief is full-on.'
  },
  {
    path: 'lighting.ground.offKm', group: 'Lighting', label: 'Ground detail off (km)', kind: 'baked',
    min: 0.05, max: 2, step: 0.01, description: 'Camera distance over which near-ground micro-relief has fully faded out.'
  },
  {
    path: 'lighting.ground.strength', group: 'Lighting', label: 'Ground detail strength', kind: 'baked',
    min: 0, max: 0.2, step: 0.005, description: 'Near-ground micro-relief normal-tilt amount.'
  },
  {
    path: 'lighting.brdf.oppCos', group: 'Lighting', label: 'Opposition width', kind: 'baked',
    min: 0.8, max: 1, step: 0.005, description: 'Cosine threshold of the opposition surge (higher = narrower hotspot).'
  },
  {
    path: 'lighting.brdf.f0', group: 'Lighting', label: 'Fresnel F0', kind: 'baked',
    min: 0.02, max: 0.07, step: 0.001, description: 'Specular reflectance at normal incidence (0.04 rock, 0.022 ice).'
  },
  {
    path: 'lighting.brdf.specAa', group: 'Lighting', label: 'Specular AA', kind: 'baked',
    min: 0, max: 2, step: 0.05, description: 'Geometric specular antialiasing (higher = softer highlights).'
  },
  {
    path: 'lighting.brdf.specMax', group: 'Lighting', label: 'Specular clamp', kind: 'baked',
    min: 0, max: 10, step: 0.1, description: 'Firefly clamp on the specular term (caps grazing blow-ups).'
  },
  {
    path: 'lighting.ground.octaves', group: 'Lighting', label: 'Ground detail octaves', kind: 'baked', int: true,
    min: 0, max: 8, step: 1, description: 'Number of near-ground df64 micro-relief octaves.'
  },
  {
    path: 'lighting.atmoDensity', group: 'Lighting', label: 'Aerial fog', kind: 'uniform',
    min: 0, max: 0.5, step: 0.001, description: 'Aerial fog density for dusty airless bodies (0 = off). Live.'
  },

  // --- Anti-alias (shading-normal grain control, esp. grazing sun). All baked. --------------------
  {
    path: 'lighting.brdf.normalAa', group: 'Anti-alias', label: 'Normal AA', kind: 'baked',
    min: 0, max: 40, step: 0.5, description: 'Diffuse normal antialiasing. Higher = smoother sooner (less grazing-sun grain).'
  },
  {
    path: 'lighting.brdf.meanAaK', group: 'Anti-alias', label: 'Mean-AA correction', kind: 'baked',
    min: 0, max: 0.6, step: 0.01, description: 'Mean-preserving darkening so normal-AA does not over-brighten at grazing (uPerfMask bit5).'
  },
  {
    path: 'lighting.brdf.craterFpK', group: 'Anti-alias', label: 'Crater footprint', kind: 'baked',
    min: 0, max: 0.01, step: 0.0005, description: 'Per-vertex crater footprint scale: higher fades sub-leaf craters sooner (no square facets at distance).'
  },

  // --- TERRAIN LOD / performance (recreates the GPU source on Apply). All baked. ---------------------
  {
    path: 'lod.splitPx', group: 'LOD', label: 'Split (px)', kind: 'baked',
    min: 2, max: 64, step: 0.5, description: 'Split a leaf when its longest edge exceeds this many pixels. LOWER = finer mesh = more cost.'
  },
  {
    path: 'lod.mergePx', group: 'LOD', label: 'Merge (px)', kind: 'baked',
    min: 1, max: 64, step: 0.5, description: 'Merge below this many pixels. Keep < Split (hysteresis; ideally < Split/1.41).'
  },
  {
    path: 'lod.capacityPow', group: 'LOD', label: 'Pool size (2^N)', kind: 'baked', int: true,
    min: 16, max: 22, step: 1, description: 'GPU leaf-pool capacity = 2^N slots. Raise if the limb under-tessellates (saturation); costs VRAM + topology passes.'
  },
  {
    path: 'lod.minLevel', group: 'LOD', label: 'Min level', kind: 'baked', int: true,
    min: 0, max: 16, step: 1, description: 'Force-refine the whole sphere to at least this level (rounder far limb).'
  },
  {
    path: 'lod.maxLevel', group: 'LOD', label: 'Max level', kind: 'baked', int: true,
    min: 8, max: 64, step: 1, description: 'Hard subdivision cap (df64 cracks well before ~32).'
  }
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

/** Write a value (number or array) at a dotted path, creating intermediate objects as needed. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cur[keys[i]];
    if (next == null || typeof next !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}
