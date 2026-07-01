import { RawTexture2DArray, Constants, type Scene } from '@babylonjs/core';

/** One layer's already-decoded RGBA8 pixels, width*height*4 bytes, row-major. */
export type LayerRgba8 = {
    readonly data: Uint8Array;
};

/**
 * Concatenate per-layer RGBA8 buffers into the flat buffer RawTexture2DArray expects
 * (layer 0 fully first, then layer 1, ...). Throws on a byte-length mismatch instead of
 * silently corrupting every later layer's offset.
 */
export function packLayersRgba8(layers: readonly LayerRgba8[], width: number, height: number): Uint8Array {
    const bytesPerLayer = width * height * 4;
    const out = new Uint8Array(bytesPerLayer * layers.length);
    layers.forEach((layer, i) => {
        if (layer.data.length !== bytesPerLayer) {
            throw new Error(
                `packLayersRgba8: layer ${i} has ${layer.data.length} bytes, expected ${bytesPerLayer} ` +
                `(width=${width} height=${height})`
            );
        }
        out.set(layer.data, i * bytesPerLayer);
    });
    return out;
}

/** Flat-color placeholder layer (smoke-test only — replaced by decoded image pixels in Step 1c). */
export function solidColorLayer(width: number, height: number, r: number, g: number, b: number, a = 255): LayerRgba8 {
    const data = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p++) {
        data[p * 4] = r;
        data[p * 4 + 1] = g;
        data[p * 4 + 2] = b;
        data[p * 4 + 3] = a;
    }
    return { data };
}

/** Create the RawTexture2DArray from already-packed bytes. */
export function createArrayTexture(
    scene: Scene,
    packed: Uint8Array,
    width: number,
    height: number,
    depth: number,
    generateMipMaps: boolean,
    samplingMode: number
): RawTexture2DArray {
    return RawTexture2DArray.CreateRGBATexture(
        packed,
        width,
        height,
        depth,
        scene,
        generateMipMaps,
        false, // invertY — matches existing project textures
        samplingMode,
        Constants.TEXTURETYPE_UNSIGNED_BYTE
    );
}
