import { describe, expect, it } from 'vitest';
import {
    normalizeCatalogJSON,
    normalizeSystemJSON,
} from './stellar_catalog_normalizer';

describe('stellar_catalog_normalizer', () => {
    it('normalizes legacy single-system payloads', () => {
        const catalog = normalizeCatalogJSON({
            Earth: {
                type: 'planet',
                position_km: [1, 2, 3],
                diameter_km: 12742,
                rotation_period_days: 1,
            },
        });

        expect(Object.keys(catalog.systems)).toEqual(['Sol']);
        expect(catalog.default).toBe('Sol');
        expect(catalog.systems.Sol.bodies.Earth.position_km).toEqual([1, 2, 3]);
        expect(catalog.systems.Sol.bodies.Earth.lod_algorithm).toBe('cdlod');
    });

    it('normalizes multi-system payloads with optional metadata', () => {
        const catalog = normalizeCatalogJSON({
            default: 'AlphaCentauri',
            systems: {
                AlphaCentauri: {
                    origin_km: [10, 20, 30],
                    displayName: 'Alpha Centauri',
                    bodies: {
                        Proxima: {
                            type: 'sun',
                            lod_algorithm: 'cbt',
                            position_km: [0, 0, 0],
                            diameter: 1000,
                            rotation_period_days: null,
                            star: { intensity: 2, color_rgb: [1, 0.8, 0.7] },
                        },
                    },
                },
            },
        });

        expect(catalog.default).toBe('AlphaCentauri');
        expect(catalog.systems.AlphaCentauri.displayName).toBe('Alpha Centauri');
        expect(catalog.systems.AlphaCentauri.bodies.Proxima.type).toBe('star');
        expect(catalog.systems.AlphaCentauri.bodies.Proxima.diameter_km).toBe(1000);
        expect(catalog.systems.AlphaCentauri.bodies.Proxima.lod_algorithm).toBe('cbt');
        expect(catalog.systems.AlphaCentauri.bodies.Proxima.star?.color_rgb).toEqual([1, 0.8, 0.7]);
    });

    it('sanitizes invalid body fields', () => {
        const system = normalizeSystemJSON({
            Broken: {
                type: 123,
                position_km: ['a', null, {}],
                diameter_km: 'NaN',
                rotation_period_days: 'unknown',
                lod_algorithm: 'invalid',
                star: {
                    temperature_k: 'hot',
                    intensity: 'fast',
                    color_rgb: [1, 'x', 3],
                },
            },
        });

        expect(system.Broken.type).toBe('planet');
        expect(system.Broken.position_km).toEqual([0, 0, 0]);
        expect(system.Broken.diameter_km).toBe(0);
        expect(system.Broken.rotation_period_days).toBeNull();
        expect(system.Broken.lod_algorithm).toBe('cdlod');
        expect(system.Broken.star).toEqual({
            temperature_k: undefined,
            intensity: undefined,
            color_rgb: undefined,
        });
    });
});
