import { describe, it, expect } from 'vitest';
import {
    poolBitfieldWords,
    poolTreeWords,
    poolLayout,
    poolWgslPreamble,
    POOL_BITFIELD_BINDING,
    POOL_TREE_BINDING
} from './ocbt_buffers';
import { OCBT_DEFAULT_CAPACITY } from './ocbt_pool';

describe('ocbt_buffers — word counts', () => {
    it('bitfield = capacity/32 words, tree = 2*capacity words', () => {
        expect(poolBitfieldWords(64)).toBe(2);
        expect(poolBitfieldWords(1 << 18)).toBe(8192);
        expect(poolTreeWords(8)).toBe(16);
        expect(poolTreeWords(1 << 18)).toBe(1 << 19);
    });
    it('rejects non-power-of-two capacity', () => {
        expect(() => poolBitfieldWords(48)).toThrow();
        expect(() => poolTreeWords(0)).toThrow();
    });
});

describe('ocbt_buffers — layout', () => {
    it('resolves the default 256K-slot layout', () => {
        const l = poolLayout();
        expect(l.capacity).toBe(OCBT_DEFAULT_CAPACITY);
        expect(l.capacity).toBe(1 << 18);
        expect(l.depth).toBe(18);
        expect(l.bitfieldWords).toBe(8192);
        expect(l.treeWords).toBe(1 << 19);
        expect(l.bitfieldBytes).toBe(8192 * 4);
        expect(l.treeBytes).toBe((1 << 19) * 4);
        expect(l.totalBytes).toBe(l.bitfieldBytes + l.treeBytes);
        // 32 KiB bitfield + 2 MiB tree = ~2.03 MiB for the pool at 256K slots.
        expect(l.totalBytes).toBe(32 * 1024 + 2 * 1024 * 1024);
        expect(l.bitfieldBinding).toBe(POOL_BITFIELD_BINDING);
        expect(l.treeBinding).toBe(POOL_TREE_BINDING);
        expect(l.bitfieldBinding).not.toBe(l.treeBinding);
    });
    it('scales to a smaller capacity', () => {
        const l = poolLayout(1 << 17);
        expect(l.depth).toBe(17);
        expect(l.bitfieldWords).toBe(4096);
        expect(l.treeWords).toBe(1 << 18);
    });
});

describe('ocbt_buffers — WGSL preamble', () => {
    it('emits OCBT_CAPACITY and OCBT_DEPTH consts matching the layout', () => {
        const p = poolWgslPreamble(1 << 18);
        expect(p).toContain('const OCBT_CAPACITY : u32 = 262144u;');
        expect(p).toContain('const OCBT_DEPTH : u32 = 18u;');
    });
    it('preamble depth tracks capacity', () => {
        expect(poolWgslPreamble(8)).toContain('OCBT_DEPTH : u32 = 3u;');
        expect(poolWgslPreamble(1 << 20)).toContain('OCBT_CAPACITY : u32 = 1048576u;');
        expect(poolWgslPreamble(1 << 20)).toContain('OCBT_DEPTH : u32 = 20u;');
    });
    it('rejects non-power-of-two capacity', () => {
        expect(() => poolWgslPreamble(100)).toThrow();
    });
});
