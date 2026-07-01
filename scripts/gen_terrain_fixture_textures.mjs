// One-off fixture generator for the terrain material texture loader (ground-detail-v1.md,
// "real material texture assets" plan). Produces small, distinguishable-but-not-photographic
// PNGs so the load/decode/merge pipeline can be proven end-to-end before real sourced art
// exists. Uses ONLY Node's built-in zlib (no new dependency, per the plan's decision).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** colorType: 0 = grayscale (1 byte/px), 2 = RGB truecolor (3 bytes/px). */
function encodePng(width, height, colorType, pixelBytesPerPixel, fillPixel) {
    const stride = width * pixelBytesPerPixel;
    const raw = Buffer.alloc((stride + 1) * height); // +1 filter byte per scanline
    for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0; // filter type 0 (none)
        for (let x = 0; x < width; x++) {
            const px = fillPixel(x, y);
            const off = rowStart + 1 + x * pixelBytesPerPixel;
            for (let c = 0; c < pixelBytesPerPixel; c++) raw[off + c] = px[c];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = colorType;
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    const idat = deflateSync(raw);
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const SIZE = 64;

/** [material key, base RGB] — matches TERRAIN_MATERIAL_LAYERS order in terrain_render_material.ts. */
const MATERIALS = [
    ['regolith_fine', [140, 140, 140]],
    ['regolith_coarse', [100, 95, 90]],
    ['basalt_dark', [70, 68, 66]],
    ['ejecta_bright', [210, 205, 190]],
    ['rock_face', [95, 85, 78]]
];

const outDir = path.resolve('public/assets/terrain/selena');
mkdirSync(outDir, { recursive: true });

for (const [key, [r, g, b]] of MATERIALS) {
    // Albedo fixture: base color + a coarse checker so per-pixel content is distinguishable
    // from a flat color (proves the decode/resize path actually reads real pixel data).
    const albedoPng = encodePng(SIZE, SIZE, 2, 3, (x, y) => {
        const checker = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) * 24 - 12;
        return [
            Math.max(0, Math.min(255, r + checker)),
            Math.max(0, Math.min(255, g + checker)),
            Math.max(0, Math.min(255, b + checker))
        ];
    });
    writeFileSync(path.join(outDir, `${key}_albedo.png`), albedoPng);

    // Height fixture: a simple diagonal ramp (distinct per-pixel gradient, not flat) so the
    // height-blend WGSL logic has real variation to compare, not a constant value.
    const heightPng = encodePng(SIZE, SIZE, 0, 1, (x, y) => [Math.floor(((x + y) / (2 * SIZE)) * 255)]);
    writeFileSync(path.join(outDir, `${key}_height.png`), heightPng);
}

console.log(`Wrote ${MATERIALS.length * 2} fixture PNGs to ${outDir}`);
