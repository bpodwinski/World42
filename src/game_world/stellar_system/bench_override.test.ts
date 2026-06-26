import { describe, expect, it } from 'vitest';
import {
    BENCH_SYSTEM_ID,
    applyBenchOverride,
    benchSystemIds,
    parseBenchAlgorithm,
} from './bench_override';
import type { LoadedBody, LoadedSystem } from './stellar_catalog_loader';

function fakeBody(name: string, bodyType: string): LoadedBody {
    return { name, bodyType, rotationPeriodDays: 1 } as unknown as LoadedBody;
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
    it('returns false when absent', () => {
        expect(parseBenchAlgorithm('')).toBe(false);
        expect(parseBenchAlgorithm('?foo=1')).toBe(false);
    });

    it('returns true for any non-empty bench param', () => {
        expect(parseBenchAlgorithm('?bench=1')).toBe(true);
        expect(parseBenchAlgorithm('?bench=cbt-ocbt')).toBe(true);
    });
});

describe('benchSystemIds', () => {
    it('returns all ids when not in bench mode', () => {
        expect(benchSystemIds(['Sol', 'AlphaCentauri', BENCH_SYSTEM_ID], false)).toEqual([
            'Sol',
            'AlphaCentauri',
            BENCH_SYSTEM_ID,
        ]);
    });

    it('narrows to the benchmark system in bench mode', () => {
        expect(benchSystemIds(['Sol', 'AlphaCentauri', BENCH_SYSTEM_ID], true)).toEqual([
            BENCH_SYSTEM_ID,
        ]);
    });
});

describe('applyBenchOverride', () => {
    it('is a no-op when inactive', () => {
        const systems = fakeSystems();
        applyBenchOverride(systems, false);
        expect(systems.get(BENCH_SYSTEM_ID)!.bodies.get('BenchWorld')!.rotationPeriodDays).toBe(1);
    });

    it('freezes spin on non-star bodies and leaves stars untouched', () => {
        const systems = fakeSystems();
        applyBenchOverride(systems, true);
        const bench = systems.get(BENCH_SYSTEM_ID)!;
        expect(bench.bodies.get('BenchWorld')!.rotationPeriodDays).toBeNull();
        expect(bench.bodies.get('BenchStar')!.bodyType).toBe('star');
        expect(bench.bodies.get('BenchStar')!.rotationPeriodDays).toBe(1); // star untouched
        expect(systems.get('Sol')!.bodies.get('Earth')!.rotationPeriodDays).toBeNull();
    });
});
