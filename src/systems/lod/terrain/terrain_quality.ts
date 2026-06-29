import { DEFAULT_NOISE, type NoiseParams } from './terrain_noise';

/**
 * TERRAIN quality presets. A single setting controls the three knobs that drive
 * visual quality vs cost:
 *  - splitThresholdPx2: screen-space triangle area (px²) above which a leaf
 *    splits. LOWER = finer mesh = more leaves = more cost. Main sharpness knob.
 *  - maxDepth: hard cap on subdivision depth (max ground detail).
 *  - octaves: noise octaves — finer relief AND heavier per-pixel shader (fbm).
 *
 * `octaves` must stay <= the GLSL TERRAIN_MAX_OCTAVES (12) and is shared by the CPU
 * displacement and the per-pixel-normal shader so the normal matches the relief.
 */
export type TerrainQualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export type TerrainQualitySettings = {
    splitThresholdPx2: number;
    maxDepth: number;
    octaves: number;
};

export const TERRAIN_QUALITY_PRESETS: Record<TerrainQualityLevel, TerrainQualitySettings> = {
    low: { splitThresholdPx2: 2200, maxDepth: 20, octaves: 6 },
    medium: { splitThresholdPx2: 900, maxDepth: 24, octaves: 8 }, // current baseline
    high: { splitThresholdPx2: 450, maxDepth: 28, octaves: 9 },
    ultra: { splitThresholdPx2: 220, maxDepth: 30, octaves: 11 }
};

/**
 * Noise params for a planet. Relief is now a PLANET property, not a quality knob:
 * we return the canonical {@link DEFAULT_NOISE} unchanged so the topology is
 * identical across quality levels (TERRAIN/TERRAIN share this exact field). Quality only governs tessellation (splitThresholdPx2,
 * maxDepth) — not the terrain shape. The `octaves` field on the preset is kept for
 * reference but no longer alters the relief.
 */
export function noiseForQuality(_q: TerrainQualitySettings): NoiseParams {
    return { ...DEFAULT_NOISE };
}
