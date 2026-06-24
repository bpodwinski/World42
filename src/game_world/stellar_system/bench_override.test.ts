import { describe, expect, it } from 'vitest';
import {
    BENCH_SYSTEM_ID,
    applyBenchOverride,
    benchSystemIds,
    parseBenchAlgorithm,
} from './bench_override';
import type { LoadedBody, LoadedSystem } from './stellar_catalog_loader';

function fakeBody(name: string, bodyType: string): LoadedBody {
    // Only the fields the override touches matter; cast the rest.
    return { name, bodyType, lodAlgorithm: 'cdlod' } as unknown as LoadedBody;
}

function fakeSystems(): Map<string, LoadedSystem> {
    const sol: LoadedSystem = {
        systemId: 'Sol',
        root: null as never,
        bodies: new Map([
            ['Sun', fakeBody('Sun', 'star')],
            ['Earth', fakeBody('Earth', 'planet')],
        ]),
    };
    const bench: LoadedSystem = {
        systemId: BENCH_SYSTEM_ID,
        root: null as never,
        bodies: new Map([
            ['BenchStar', fakeBody('BenchStar', 'star')],
            ['BenchWorld', fakeBody('BenchWorld', 'planet')],
        ]),
    };
    return new Map([
        ['Sol', sol],
        [BENCH_SYSTEM_ID, bench],
    ]);
}

describe('parseBenchAlgorithm', () => {
    it('returns null when absent', () => {
        expect(parseBenchAlgorithm('')).toBeNull();
        expect(parseBenchAlgorithm('?foo=1')).toBeNull();
    });

    it('parses each valid backend', () => {
        expect(parseBenchAlgorithm('?bench=cdlod')).toBe('cdlod');
        expect(parseBenchAlgorithm('?bench=cbt-cpu')).toBe('cbt-cpu');
        expect(parseBenchAlgorithm('?bench=cbt-gpu')).toBe('cbt-gpu');
        expect(parseBenchAlgorithm('?bench=CBT-OCBT')).toBe('cbt-ocbt'); // case-insensitive
    });

    it('returns null for an unknown value', () => {
        expect(parseBenchAlgorithm('?bench=potato')).toBeNull();
    });
});

describe('benchSystemIds', () => {
    it('returns all ids when not in bench mode', () => {
        expect(benchSystemIds(['Sol', 'AlphaCentauri', BENCH_SYSTEM_ID], null)).toEqual([
            'Sol',
            'AlphaCentauri',
            BENCH_SYSTEM_ID,
        ]);
    });

    it('narrows to the benchmark system in bench mode', () => {
        expect(benchSystemIds(['Sol', 'AlphaCentauri', BENCH_SYSTEM_ID], 'cbt-ocbt')).toEqual([
            BENCH_SYSTEM_ID,
        ]);
    });
});

describe('applyBenchOverride', () => {
    it('is a no-op when algo is null', () => {
        const systems = fakeSystems();
        applyBenchOverride(systems, null);
        expect(systems.get(BENCH_SYSTEM_ID)!.bodies.get('BenchWorld')!.lodAlgorithm).toBe('cdlod');
    });

    it('forces every non-star body onto the algo and leaves stars untouched', () => {
        const systems = fakeSystems();
        applyBenchOverride(systems, 'cbt-ocbt');
        const bench = systems.get(BENCH_SYSTEM_ID)!;
        expect(bench.bodies.get('BenchWorld')!.lodAlgorithm).toBe('cbt-ocbt');
        expect(bench.bodies.get('BenchStar')!.bodyType).toBe('star');
        // Stars are not LOD bodies; their lodAlgorithm is irrelevant but must not crash.
        expect(systems.get('Sol')!.bodies.get('Earth')!.lodAlgorithm).toBe('cbt-ocbt');
    });
});
