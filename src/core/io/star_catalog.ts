/**
 * Loader for the pre-processed HYG star catalog binary.
 *
 * Binary format (little-endian):
 *   [uint32  count]                    - number of stars
 *   count × [f32 ra, f32 dec, f32 mag, f32 bv]
 *
 * ra  = right ascension in radians [0, 2π]
 * dec = declination in radians [-π/2, π/2]
 * mag = apparent visual magnitude (Johnson V)
 * bv  = B-V color index (0.6 default for missing values)
 *
 * Generate the binary with:
 *   python tools/hyg_to_binary.py tools/hyg_v41.csv public/stars/hyg_mag8.bin
 */
export type StarCatalogData = {
    /** Number of stars in the catalog. */
    count: number;
    /**
     * Interleaved Float32Array: [ra0, dec0, mag0, bv0, ra1, dec1, ...].
     * 4 floats (16 bytes) per star. Layout matches array<vec4<f32>> in WGSL.
     */
    buffer: Float32Array;
};

/**
 * Fetches and parses the binary star catalog asset.
 * Throws if the fetch fails or the data is malformed.
 */
export async function loadStarCatalog(url: string): Promise<StarCatalogData> {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Star catalog fetch failed: HTTP ${response.status} — ${url}`);
    }
    const raw = await response.arrayBuffer();
    if (raw.byteLength < 4) {
        throw new Error(`Star catalog too small (${raw.byteLength} bytes): ${url}`);
    }
    const count = new DataView(raw).getUint32(0, true);
    const expected = 4 + count * 16;
    if (raw.byteLength < expected) {
        throw new Error(`Star catalog truncated: expected ${expected} bytes, got ${raw.byteLength}`);
    }
    return {
        count,
        buffer: new Float32Array(raw, 4, count * 4)
    };
}
