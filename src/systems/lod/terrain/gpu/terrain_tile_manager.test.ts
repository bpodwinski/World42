import { describe, it, expect, beforeEach } from 'vitest';
import { TerrainTileManager, ATLAS_TILE_COUNT, ATLAS_TILE_SIZE, ATLAS_TILES_PER_ROW } from './terrain_tile_manager';

describe('TerrainTileManager', () => {
    let mgr: TerrainTileManager;

    beforeEach(() => {
        mgr = new TerrainTileManager();
    });

    it('starts fully free', () => {
        expect(mgr.freeCount).toBe(ATLAS_TILE_COUNT);
    });

    it('alloc decrements freeCount', () => {
        const idx = mgr.alloc();
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(ATLAS_TILE_COUNT);
        expect(mgr.freeCount).toBe(ATLAS_TILE_COUNT - 1);
    });

    it('alloc returns unique indices', () => {
        const seen = new Set<number>();
        for (let i = 0; i < 100; i++) {
            const idx = mgr.alloc();
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(seen.has(idx)).toBe(false);
            seen.add(idx);
        }
        expect(mgr.freeCount).toBe(ATLAS_TILE_COUNT - 100);
    });

    it('alloc exhaustion returns -1', () => {
        for (let i = 0; i < ATLAS_TILE_COUNT; i++) mgr.alloc();
        expect(mgr.freeCount).toBe(0);
        expect(mgr.alloc()).toBe(-1);
        // freeCount stays 0 after exhaustion
        expect(mgr.freeCount).toBe(0);
    });

    it('reclaim restores freeCount', () => {
        const idx = mgr.alloc();
        expect(mgr.freeCount).toBe(ATLAS_TILE_COUNT - 1);
        const freed = new Uint32Array([idx]);
        mgr.reclaim(freed, 1);
        expect(mgr.freeCount).toBe(ATLAS_TILE_COUNT);
    });

    it('reclaim ignores invalid indices', () => {
        const before = mgr.freeCount;
        // Index >= ATLAS_TILE_COUNT must be ignored
        const freed = new Uint32Array([ATLAS_TILE_COUNT, ATLAS_TILE_COUNT + 1]);
        mgr.reclaim(freed, 2);
        expect(mgr.freeCount).toBe(before);
    });

    it('reclaim does not overflow the stack (max ATLAS_TILE_COUNT entries)', () => {
        // Reclaiming when already full must not corrupt internal state
        const freed = new Uint32Array([0, 1, 2]);
        mgr.reclaim(freed, 3);
        // freeCount must not exceed ATLAS_TILE_COUNT
        expect(mgr.freeCount).toBeLessThanOrEqual(ATLAS_TILE_COUNT);
    });

    it('alloc → reclaim → alloc gives the reclaimed index', () => {
        const idx = mgr.alloc();
        mgr.reclaim(new Uint32Array([idx]), 1);
        // Next alloc should return the reclaimed index (LIFO stack)
        expect(mgr.alloc()).toBe(idx);
    });

    it('partial reclaim with count < array length only processes count entries', () => {
        mgr.alloc(); mgr.alloc();
        const freed = new Uint32Array([0, 1, 999]);
        mgr.reclaim(freed, 2); // only first 2
        expect(mgr.freeCount).toBe(ATLAS_TILE_COUNT);
    });
});

describe('TerrainTileManager.tileOrigin', () => {
    it('tile 0 is at (0, 0)', () => {
        expect(TerrainTileManager.tileOrigin(0)).toEqual([0, 0]);
    });

    it('tile ATLAS_TILES_PER_ROW is on the second row', () => {
        const [x, y] = TerrainTileManager.tileOrigin(ATLAS_TILES_PER_ROW);
        expect(x).toBe(0);
        expect(y).toBe(ATLAS_TILE_SIZE);
    });

    it('last tile is at bottom-right of atlas', () => {
        const [x, y] = TerrainTileManager.tileOrigin(ATLAS_TILE_COUNT - 1);
        expect(x).toBe((ATLAS_TILES_PER_ROW - 1) * ATLAS_TILE_SIZE);
        expect(y).toBe((ATLAS_TILES_PER_ROW - 1) * ATLAS_TILE_SIZE);
    });

    it('all tile origins are within atlas bounds (8192×8192)', () => {
        const atlasSize = ATLAS_TILES_PER_ROW * ATLAS_TILE_SIZE; // 8192
        for (let i = 0; i < ATLAS_TILE_COUNT; i++) {
            const [x, y] = TerrainTileManager.tileOrigin(i);
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x + ATLAS_TILE_SIZE).toBeLessThanOrEqual(atlasSize);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y + ATLAS_TILE_SIZE).toBeLessThanOrEqual(atlasSize);
        }
    });
});

describe('ATLAS constants', () => {
    it('ATLAS_TILE_COUNT = ATLAS_TILES_PER_ROW^2', () => {
        expect(ATLAS_TILE_COUNT).toBe(ATLAS_TILES_PER_ROW * ATLAS_TILES_PER_ROW);
    });

    it('atlas is 8192×8192 at ATLAS_TILE_SIZE=64', () => {
        expect(ATLAS_TILES_PER_ROW * ATLAS_TILE_SIZE).toBe(8192);
    });
});
