import { describe, it, expect } from 'vitest';
import { resolveLighting, DEFAULT_LIGHTING, type PlanetLightingJSON } from './planet_lighting';

const FULL_DEFAULTS: PlanetLightingJSON = {
    _defaults: {
        albedo:      [0.15, 0.14, 0.13],
        ambient:     [0.008, 0.008, 0.008],
        atmoDensity: 0,
        atmoColor:   [0, 0, 0],
        terrain: { highlandTint: [1.12, 1.12, 1.16], slopeLo: 0.03, slopeHi: 0.22, slopeDist: 2.0, plainsAmp: 0.12 },
        brdf:    { lunarLs: 0.7, oppAmp: 0.15, oppCos: 0.93, aoStrength: 0.35, roughLo: 0.6, roughHi: 0.9, f0: 0.04, specAa: 0.5, specMax: 4.0 }
    }
};

describe('resolveLighting', () => {
    it('no override falls back to _defaults', () => {
        const result = resolveLighting(FULL_DEFAULTS);
        expect(result.albedo).toEqual([0.15, 0.14, 0.13]);
        expect(result.brdf.lunarLs).toBe(0.7);
        expect(result.terrain.slopeLo).toBe(0.03);
    });

    it('empty _defaults falls back to DEFAULT_LIGHTING code values', () => {
        const json: PlanetLightingJSON = { _defaults: {} };
        const result = resolveLighting(json);
        expect(result.albedo).toEqual(DEFAULT_LIGHTING.albedo);
        expect(result.brdf.roughLo).toBe(DEFAULT_LIGHTING.brdf.roughLo);
    });

    it('override replaces only specified fields', () => {
        const json: PlanetLightingJSON = {
            _defaults: { brdf: { lunarLs: 0.7, roughLo: 0.6 } }
        };
        const result = resolveLighting(json, { brdf: { lunarLs: 0.8 } });
        expect(result.brdf.lunarLs).toBe(0.8);
        // roughLo not in override → falls back to _defaults
        expect(result.brdf.roughLo).toBe(0.6);
        // oppAmp not in override or _defaults → falls back to DEFAULT_LIGHTING
        expect(result.brdf.oppAmp).toBe(DEFAULT_LIGHTING.brdf.oppAmp);
    });

    it('override wins over _defaults', () => {
        const json: PlanetLightingJSON = {
            _defaults: { albedo: [0.1, 0.1, 0.1] }
        };
        const result = resolveLighting(json, { albedo: [0.2, 0.1, 0.05] });
        expect(result.albedo).toEqual([0.2, 0.1, 0.05]);
    });

    it('sub-object fields merge independently', () => {
        const json: PlanetLightingJSON = {
            _defaults: {
                terrain: { highlandTint: [1.1, 1.1, 1.1], slopeLo: 0.04 }
            }
        };
        const result = resolveLighting(json, { terrain: { slopeLo: 0.08 } });
        // Override wins for slopeLo
        expect(result.terrain.slopeLo).toBe(0.08);
        // highlandTint comes from _defaults
        expect(result.terrain.highlandTint).toEqual([1.1, 1.1, 1.1]);
        // slopeHi not in either → DEFAULT_LIGHTING
        expect(result.terrain.slopeHi).toBe(DEFAULT_LIGHTING.terrain.slopeHi);
    });

    it('atmoDensity = 0 by default', () => {
        const result = resolveLighting(FULL_DEFAULTS);
        expect(result.atmoDensity).toBe(0);
    });

    it('returns ResolvedLighting with all required fields', () => {
        const result = resolveLighting(FULL_DEFAULTS, {
            albedo:  [0.07, 0.07, 0.07],
            terrain: { highlandTint: [1.05, 1.05, 1.05], plainsAmp: 0.08 },
            brdf:    { lunarLs: 0.8, oppAmp: 0.22, aoStrength: 0.45 }
        });
        expect(Array.isArray(result.albedo)).toBe(true);
        expect(Array.isArray(result.ambient)).toBe(true);
        expect(typeof result.atmoDensity).toBe('number');
        expect(Array.isArray(result.atmoColor)).toBe(true);
        expect(typeof result.terrain.plainsAmp).toBe('number');
        expect(typeof result.brdf.f0).toBe('number');
        expect(typeof result.brdf.specAa).toBe('number');
        expect(typeof result.brdf.specMax).toBe('number');
    });
});
