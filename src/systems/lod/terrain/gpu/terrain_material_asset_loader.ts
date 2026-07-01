import { RawTexture2DArray, Tools, Constants, type Scene } from '@babylonjs/core';
import { packLayersRgba8, createArrayTexture, type LayerRgba8 } from './terrain_material_textures';

/** Source image paths for one material's combined-channel layer. */
export type MaterialChannelSource = {
    /** RGB source (e.g. albedo color, or normal.xy packed as RG) → target RGB. */
    readonly rgb: string;
    /** Grayscale source (its R channel is read) → target alpha (e.g. height, or roughness). */
    readonly alpha: string;
};

function loadBitmap(url: string): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
        Tools.LoadImage(
            url,
            (img) => resolve(img as ImageBitmap),
            (message) => reject(new Error(message ?? `failed to load ${url}`)),
            null
        );
    });
}

/**
 * Decode one material's RGB + alpha source images, resize both to `size`x`size`, and merge
 * into one RGBA8 layer. Canvas 2D decodes through sRGB — correct for the RGB (color) source,
 * an accepted cosmetic approximation for the alpha source when it holds height/roughness
 * (parametric, not color) data. Height is only ever used as a RELATIVE difference in the
 * terrain shader's height blend, so the gamma skew (monotonic) does not affect blend ordering.
 */
async function decodeChannelLayer(source: MaterialChannelSource, size: number): Promise<LayerRgba8> {
    const [rgbBitmap, alphaBitmap] = await Promise.all([loadBitmap(source.rgb), loadBitmap(source.alpha)]);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('decodeChannelLayer: 2D context unavailable');

    ctx.drawImage(rgbBitmap, 0, 0, size, size);
    const rgbData = ctx.getImageData(0, 0, size, size).data;

    ctx.drawImage(alphaBitmap, 0, 0, size, size);
    const alphaData = ctx.getImageData(0, 0, size, size).data;

    const data = new Uint8Array(size * size * 4);
    for (let p = 0; p < size * size; p++) {
        data[p * 4] = rgbData[p * 4];
        data[p * 4 + 1] = rgbData[p * 4 + 1];
        data[p * 4 + 2] = rgbData[p * 4 + 2];
        data[p * 4 + 3] = alphaData[p * 4];
    }
    return { data };
}

const arrayTextureCache = new Map<string, Promise<RawTexture2DArray>>();

/**
 * Load and GPU-upload one profile's material layer set as a texture_2d_array. Cached by
 * `cacheKey` (e.g. `selena:albedoHeight`) so multiple bodies on the same profile share one
 * decode + one GPU texture instead of re-fetching/re-uploading per body.
 *
 * Rejects only on a genuine load/decode failure (missing file, malformed image, no 2D
 * context) — callers are expected to `.catch()` and keep their existing placeholder texture
 * bound rather than propagate the failure further.
 */
export function loadMaterialArrayTexture(
    scene: Scene,
    cacheKey: string,
    sources: readonly MaterialChannelSource[],
    size: number
): Promise<RawTexture2DArray> {
    const cached = arrayTextureCache.get(cacheKey);
    if (cached) return cached;

    const promise = Promise.all(sources.map((s) => decodeChannelLayer(s, size))).then((layers) => {
        const packed = packLayersRgba8(layers, size, size);
        return createArrayTexture(scene, packed, size, size, layers.length, true, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
    });
    arrayTextureCache.set(cacheKey, promise);
    return promise;
}
