import { DEFAULT_NOISE, type NoiseParams } from './cbt_noise';

/**
 * CBT quality presets. A single setting controls the three knobs that drive
 * visual quality vs cost:
 *  - splitThresholdPx2: screen-space triangle area (px²) above which a leaf
 *    splits. LOWER = finer mesh = more leaves = more cost. Main sharpness knob.
 *  - maxDepth: hard cap on subdivision depth (max ground detail).
 *  - octaves: noise octaves — finer relief AND heavier per-pixel shader (fbm).
 *
 * `octaves` must stay <= the GLSL CBT_MAX_OCTAVES (12) and is shared by the CPU
 * displacement and the per-pixel-normal shader so the normal matches the relief.
 */
export type CbtQualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export type CbtQualitySettings = {
    splitThresholdPx2: number;
    maxDepth: number;
    octaves: number;
};

export const CBT_QUALITY_PRESETS: Record<CbtQualityLevel, CbtQualitySettings> = {
    low: { splitThresholdPx2: 2200, maxDepth: 20, octaves: 6 },
    medium: { splitThresholdPx2: 900, maxDepth: 24, octaves: 8 }, // current baseline
    high: { splitThresholdPx2: 450, maxDepth: 28, octaves: 9 },
    ultra: { splitThresholdPx2: 220, maxDepth: 30, octaves: 11 }
};

/** Noise params for a quality preset (DEFAULT_NOISE with the preset's octaves). */
export function noiseForQuality(q: CbtQualitySettings): NoiseParams {
    return { ...DEFAULT_NOISE, octaves: q.octaves };
}
