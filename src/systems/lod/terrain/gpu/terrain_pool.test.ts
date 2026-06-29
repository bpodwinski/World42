import { describe, it, expect } from 'vitest';
import { TerrainPool } from './terrain_cpu_mirror';
import { assertPowerOfTwo, bitfieldWordCount, log2PowerOfTwo } from './terrain_pool';

/** Brute-force oracle: allocated slots in ascending order, straight from the bitfield. */
function allocatedBrute(pool: TerrainPool): number[] {
    const out: number[] = [];
    for (let s = 0; s < pool.capacity; s++) if (pool.getBit(s)) out.push(s);
    return out;
}
function freeBrute(pool: TerrainPool): number[] {
    const out: number[] = [];
    for (let s = 0; s < pool.capacity; s++) if (!pool.getBit(s)) out.push(s);
    return out;
}

describe('terrain_pool layout helpers', () => {
    it('validates power-of-two capacity', () => {
        expect(() => assertPowerOfTwo(8)).not.toThrow();
        expect(() => assertPowerOfTwo(1 << 18)).not.toThrow();
        expect(() => assertPowerOfTwo(0)).toThrow();
        expect(() => assertPowerOfTwo(1)).toThrow();
        expect(() => assertPowerOfTwo(48)).toThrow();
    });
    it('computes bitfield word count and log2', () => {
        expect(bitfieldWordCount(8)).toBe(1);
        expect(bitfieldWordCount(64)).toBe(2);
        expect(bitfieldWordCount(1 << 18)).toBe(8192);
        expect(log2PowerOfTwo(8)).toBe(3);
        expect(log2PowerOfTwo(1 << 18)).toBe(18);
    });
});

describe('TerrainPool — golden (capacity 8)', () => {
    it('decodes the i-th allocated / free slot after a hand-set bitfield', () => {
        const p = new TerrainPool(8);
        // Allocate slots {1, 2, 5} by hand, then reduce from the bitfield.
        for (const s of [1, 2, 5]) p.setBit(s, true);
        expect(p.count()).toBe(3);
        expect(p.freeCount()).toBe(5);
        // i-th allocated, ascending
        expect([0, 1, 2].map((i) => p.decodeBit(i))).toEqual([1, 2, 5]);
        // i-th free, ascending: {0,3,4,6,7}
        expect([0, 1, 2, 3, 4].map((i) => p.decodeBitComplement(i))).toEqual([0, 3, 4, 6, 7]);
    });

    it('reduce() rebuilds the tree from a bulk-loaded bitfield identically', () => {
        const a = new TerrainPool(8);
        for (const s of [0, 3, 7]) a.setBit(s, true); // incremental path updates
        const b = new TerrainPool(8);
        for (const s of [0, 3, 7]) (b as unknown as { bits: Uint32Array }).bits[s >>> 5] |= 1 << (s & 31);
        b.reduce(); // bulk rebuild
        expect(b.count()).toBe(a.count());
        expect(b.allocatedSlots()).toEqual(a.allocatedSlots());
        expect([0, 1, 2, 3, 4].map((i) => b.decodeBitComplement(i))).toEqual(
            [0, 1, 2, 3, 4].map((i) => a.decodeBitComplement(i))
        );
    });
});

describe('TerrainPool — allocate / free', () => {
    it('allocates lowest free slots first and fills to capacity', () => {
        const p = new TerrainPool(16);
        expect(p.allocate(3)).toEqual([0, 1, 2]);
        expect(p.allocate(2)).toEqual([3, 4]);
        expect(p.count()).toBe(5);
        // free 1 and 3, next allocate reuses them (lowest-first)
        p.free(1);
        p.free(3);
        expect(p.count()).toBe(3);
        expect(p.allocate(2)).toEqual([1, 3]);
        expect(p.allocatedSlots()).toEqual([0, 1, 2, 3, 4]);
    });

    it('fills the whole pool and throws on overflow', () => {
        const p = new TerrainPool(8);
        const all = p.allocate(8);
        expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(p.count()).toBe(8);
        expect(p.freeCount()).toBe(0);
        expect(() => p.allocate(1)).toThrow(/out of memory/);
    });
});

describe('TerrainPool — fuzz vs brute force', () => {
    it('decode/count match brute force across random alloc/free (capacity 1024)', () => {
        const cap = 1024;
        const p = new TerrainPool(cap);
        // Seeded LCG for reproducibility (no Math.random).
        let s = 0x1234_5678 >>> 0;
        const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);

        const live = new Set<number>();
        for (let iter = 0; iter < 2000; iter++) {
            const free = cap - live.size;
            // Bias toward allocation when mostly empty, toward free when mostly full.
            const doAlloc = free > 0 && (live.size === 0 || rnd() < 0.55);
            if (doAlloc) {
                const [slot] = p.allocate(1);
                expect(live.has(slot)).toBe(false);
                live.add(slot);
            } else if (live.size > 0) {
                // free a random live slot
                const arr = [...live];
                const victim = arr[Math.floor(rnd() * arr.length)];
                p.free(victim);
                live.delete(victim);
            }

            if (iter % 37 === 0) {
                expect(p.count()).toBe(live.size);
                expect(p.allocatedSlots()).toEqual(allocatedBrute(p));
                const fb = freeBrute(p);
                expect(p.freeCount()).toBe(fb.length);
                // spot-check a few complement decodes against the brute free list
                for (let k = 0; k < Math.min(5, fb.length); k++) {
                    expect(p.decodeBitComplement(k)).toBe(fb[k]);
                }
            }
        }
    });
});
