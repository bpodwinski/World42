import { describe, it, expect } from 'vitest';
import {
    engineLayout,
    buildEngineSeed,
    engineWgslPreamble,
    heapIdWords,
    neighborsWords,
    bisectorDataWords,
    classificationWords,
    simplificationWords,
    allocateWords,
    propagateWords,
    BINDING,
    HEAP_ID_WORDS,
    NEIGHBORS_WORDS,
    BISECTOR_DATA_WORDS,
    N0,
    N1,
    N2,
    OCBT_INVALID,
    VISIBLE_BISECTOR,
    UNCHANGED_ELEMENT
} from './ocbt_engine_buffers';

describe('ocbt_engine_buffers — strides', () => {
    it('per-slot word counts scale with capacity', () => {
        expect(heapIdWords(8)).toBe(16);
        expect(neighborsWords(8)).toBe(24);
        expect(bisectorDataWords(8)).toBe(64);
        expect(heapIdWords(1 << 18)).toBe(2 * (1 << 18));
    });
    it('work-buffer headers match the reference (mesh.cpp)', () => {
        const cap = 1 << 10;
        expect(classificationWords(cap)).toBe(2 + 2 * cap);
        expect(simplificationWords(cap)).toBe(1 + cap);
        expect(allocateWords(cap)).toBe(1 + cap);
        expect(propagateWords(cap)).toBe(2 + cap);
    });
    it('rejects non-power-of-two capacity', () => {
        expect(() => heapIdWords(100)).toThrow();
    });
});

describe('ocbt_engine_buffers — layout', () => {
    it('sizes the default 256K-slot engine', () => {
        const l = engineLayout();
        const cap = 1 << 18;
        expect(l.capacity).toBe(cap);
        expect(l.depth).toBe(18);
        expect(l.heapIdBytes).toBe(cap * 2 * 4);
        expect(l.neighborsBytes).toBe(cap * 3 * 4);
        expect(l.bisectorDataBytes).toBe(cap * 8 * 4);
        expect(l.classificationBytes).toBe((2 + 2 * cap) * 4);
        expect(l.memoryBytes).toBe(8);
        expect(l.indirectDispatchBytes).toBe(36);
        expect(l.indirectDrawBytes).toBe(40);
        // Total must equal the explicit sum of all components (ping+pong, 3 lists).
        const expected =
            l.bitfieldBytes +
            l.treeBytes +
            l.heapIdBytes +
            2 * l.neighborsBytes +
            l.bisectorDataBytes +
            l.classificationBytes +
            l.simplificationBytes +
            l.allocateBytes +
            l.propagateBytes +
            l.memoryBytes +
            l.indirectDispatchBytes +
            l.indirectDrawBytes +
            3 * l.bisectorIndicesBytes +
            l.validationBytes;
        expect(l.totalBytes).toBe(expected);
    });
    it('all bindings are distinct', () => {
        const vals = Object.values(BINDING);
        expect(new Set(vals).size).toBe(vals.length);
    });
});

describe('ocbt_engine_buffers — octahedron seed', () => {
    it('heapIDs are 8..15 with hi=0', () => {
        const seed = buildEngineSeed(1 << 18);
        expect(seed.liveCount).toBe(8);
        for (let i = 0; i < 8; i++) {
            expect(seed.heapID[i * HEAP_ID_WORDS + 0]).toBe(8 + i);
            expect(seed.heapID[i * HEAP_ID_WORDS + 1]).toBe(0);
        }
    });
    it('marks slots 0..7 allocated in the bitfield', () => {
        const seed = buildEngineSeed(1 << 18);
        expect(seed.bitfield[0]).toBe(0xff);
        expect(seed.bitfield[1]).toBe(0);
    });
    it('remaps ROOT_NEIGHBORS [BASE,LEFT,RIGHT] -> reference (n0=LEFT,n1=RIGHT,n2=BASE)', () => {
        const seed = buildEngineSeed(1 << 18);
        // Face 0 consistently-oriented adjacency = [base=4, left=1, right=3].
        const o = 0 * NEIGHBORS_WORDS;
        expect(seed.neighbors[o + N0]).toBe(1); // LEFT
        expect(seed.neighbors[o + N1]).toBe(3); // RIGHT
        expect(seed.neighbors[o + N2]).toBe(4); // BASE / twin
    });
    it('seed neighbor twins (n2) are reciprocal across the 4 base diamonds', () => {
        const seed = buildEngineSeed(1 << 18);
        const twin = (i: number) => seed.neighbors[i * NEIGHBORS_WORDS + N2];
        // ROOT base pairs: (0,4)(1,5)(2,6)(3,7).
        for (const [a, b] of [
            [0, 4],
            [1, 5],
            [2, 6],
            [3, 7]
        ]) {
            expect(twin(a)).toBe(b);
            expect(twin(b)).toBe(a);
        }
    });
    it('every seed neighbor reference is symmetric (i lists j => j lists i)', () => {
        const seed = buildEngineSeed(1 << 18);
        const nb = (i: number, e: number) => seed.neighbors[i * NEIGHBORS_WORDS + e];
        for (let i = 0; i < 8; i++) {
            for (const e of [N0, N1, N2]) {
                const j = nb(i, e);
                expect(j).toBeGreaterThanOrEqual(0);
                expect(j).toBeLessThan(8);
                const back = [nb(j, N0), nb(j, N1), nb(j, N2)];
                expect(back).toContain(i);
            }
        }
    });
    it('seed bisectorData defaults: pattern 0, invalid indices, visible, unchanged', () => {
        const seed = buildEngineSeed(1 << 18);
        for (let i = 0; i < 8; i++) {
            const b = i * BISECTOR_DATA_WORDS;
            expect(seed.bisectorData[b + 0]).toBe(0); // pattern
            expect(seed.bisectorData[b + 1]).toBe(OCBT_INVALID);
            expect(seed.bisectorData[b + 5]).toBe(UNCHANGED_ELEMENT >>> 0);
            expect(seed.bisectorData[b + 6]).toBe(VISIBLE_BISECTOR);
        }
    });
});

describe('ocbt_engine_buffers — WGSL preamble', () => {
    it('emits capacity, depth, sentinel and stride consts', () => {
        const p = engineWgslPreamble(1 << 18);
        expect(p).toContain('const OCBT_CAPACITY : u32 = 262144u;');
        expect(p).toContain('const OCBT_DEPTH : u32 = 18u;');
        expect(p).toContain('const OCBT_INVALID : u32 = 4294967295u;');
        expect(p).toContain('const BISECTOR_DATA_WORDS : u32 = 8u;');
    });
});
