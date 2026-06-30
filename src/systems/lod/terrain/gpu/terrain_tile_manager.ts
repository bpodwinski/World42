import {
    ATLAS_TILE_COUNT,
    ATLAS_TILE_SIZE,
    ATLAS_TILES_PER_ROW
} from './terrain_engine_buffers';

export { ATLAS_TILE_COUNT, ATLAS_TILE_SIZE, ATLAS_TILES_PER_ROW };

/**
 * CPU-side free list for the 16,384-slot tile atlas. Keeps track of which tile
 * indices are available. Slots freed by the GPU (via freed_tiles readback) are
 * returned here so they can be re-allocated to new stable OCBT slots.
 */
export class TerrainTileManager {
    private readonly freeStack = new Uint16Array(ATLAS_TILE_COUNT);
    private freeTop = ATLAS_TILE_COUNT - 1;

    constructor() {
        for (let i = 0; i < ATLAS_TILE_COUNT; i++) this.freeStack[i] = i;
    }

    /** Allocate one tile index. Returns -1 when exhausted. */
    alloc(): number {
        return this.freeTop >= 0 ? this.freeStack[this.freeTop--] : -1;
    }

    /** Return freed tile indices (from GPU freed_tiles readback). */
    reclaim(indices: Uint32Array, count: number): void {
        for (let i = 0; i < count; i++) {
            const idx = indices[i];
            if (idx < ATLAS_TILE_COUNT && this.freeTop < ATLAS_TILE_COUNT - 1) {
                this.freeStack[++this.freeTop] = idx;
            }
        }
    }

    get freeCount(): number {
        return this.freeTop + 1;
    }

    /** Top-left texel coordinate of tile `idx` in the 8192×8192 atlas. */
    static tileOrigin(idx: number): [number, number] {
        return [
            (idx % ATLAS_TILES_PER_ROW) * ATLAS_TILE_SIZE,
            Math.floor(idx / ATLAS_TILES_PER_ROW) * ATLAS_TILE_SIZE
        ];
    }
}
