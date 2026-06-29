/**
 * World42 grazing-sun normal-aliasing probe.
 *
 * Measures the per-pixel shading grain at a deterministic raking-light ground pose by comparing the
 * NATIVE render against a SUPERSAMPLED render of the SAME frame (the alias-free ground truth). Topology
 * is FROZEN during the sweep (__terrainFreezeTopology) so native and SSAA share the EXACT same leaf set —
 * the only difference is the fragment sample rate, so the delta is PURE shading aliasing (no geometric
 * LOD difference). The reference is produced for free by the browser: at hwScale 0.25 the engine renders
 * the canvas backing-store at 4x and the compositor downscales it to the CSS size, so page.screenshot
 * returns a 16x-supersampled image at the SAME pixel size as the native shot → direct RMSE, no resample.
 *
 * Two numbers per config, on a 0..255 luminance scale:
 *   - grain RMSE : sqrt(mean((native - ssaa)^2)) over the grazing band. THE metric (deviation from truth).
 *   - HF energy  : sqrt(mean(Laplacian(native)^2)) — a reference-free high-frequency proxy.
 * A perfMask sweep attributes the grain to each shading block (slope normal / df64 / crater rays).
 *
 * Usage (dev server must be running):
 *   node scripts/grain_probe.mjs
 *   node scripts/grain_probe.mjs --planet Moon --sunElev 4 --ssaa 0.25 --band 0.25,0.5,0.5,0.45
 * Flags: --url, --planet <suffix>, --alt <km>, --sunElev <deg>, --ssaa <hwScale>, --band x,y,w,h
 *        (canvas fractions), --masks <a,b,..> (perfMask values), --keep.
 */
import { chromium } from 'playwright';
import zlib from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '.bench');
const VIEW = { width: 1500, height: 950 };

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
}
const URL = arg('url', 'http://localhost:19000/?system=Dev&planet=Moon');
const PLANET = arg('planet', 'Moon');
const ALT = parseFloat(arg('alt', '3'));
const SUN_ELEV = parseFloat(arg('sunElev', '5'));
const PITCH = parseFloat(arg('pitch', '0')); // view tilt from nadir toward the sun (deg)
const SSAA = parseFloat(arg('ssaa', '0.25')); // hwScale for the reference (0.25 = 16 samples/px)
const BAND = arg('band', '0.55,0.05,0.38,0.4').split(',').map(Number); // x,y,w,h canvas fractions (on the lit grain patch)
const MASKS = arg('masks', '0,1,2,4').split(',').map((s) => parseInt(s, 10));
const KEEP = arg('keep', false) === true;
// --saveRef captures the SSAA band as a FIXED reference (run it once with the AA-OFF build); --useRef
// compares native against that saved reference instead of a fresh same-AA SSAA. This is required to tune
// TERRAIN_NORMAL_AA itself: a same-AA SSAA reference flattens with the AA, so the RMSE degenerates to 0; an
// AA-off supersampled reference is the true anti-aliased image, so over-smoothing shows as RMSE rising.
const SAVE_REF = arg('saveRef', false) === true;
const USE_REF = arg('useRef', false) === true;
const REF_PATH = join(OUT_DIR, 'grain_ref.json');

const MASK_LABEL = { 0: 'baseline', 1: 'slope-norm off', 2: 'df64 off', 4: 'crater-rays off', 31: 'all-shading off' };
const CLIP = {
    x: Math.round(BAND[0] * VIEW.width),
    y: Math.round(BAND[1] * VIEW.height),
    width: Math.round(BAND[2] * VIEW.width),
    height: Math.round(BAND[3] * VIEW.height)
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };

// Minimal PNG decoder (8-bit, non-interlaced — what Playwright emits) → per-pixel luminance.
function decodePngToLum(buf) {
    let p = 8; // skip signature
    let w = 0, h = 0, colorType = 6;
    const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString('ascii', p + 4, p + 8);
        const data = p + 8;
        if (type === 'IHDR') { w = buf.readUInt32BE(data); h = buf.readUInt32BE(data + 4); colorType = buf[data + 9]; }
        else if (type === 'IDAT') idat.push(buf.subarray(data, data + len));
        else if (type === 'IEND') break;
        p = data + len + 4; // + CRC
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
    const stride = w * ch;
    const lum = new Float32Array(w * h);
    const prev = new Uint8Array(stride);
    const cur = new Uint8Array(stride);
    let rp = 0;
    for (let y = 0; y < h; y++) {
        const filter = raw[rp++];
        for (let x = 0; x < stride; x++) {
            const rb = raw[rp++];
            const a = x >= ch ? cur[x - ch] : 0;
            const b = prev[x];
            const c = x >= ch ? prev[x - ch] : 0;
            let v;
            switch (filter) {
                case 1: v = rb + a; break;
                case 2: v = rb + b; break;
                case 3: v = rb + ((a + b) >> 1); break;
                case 4: {
                    const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                    v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
                    break;
                }
                default: v = rb;
            }
            cur[x] = v & 0xff;
        }
        for (let x = 0; x < w; x++) {
            const o = x * ch;
            const R = cur[o], G = ch >= 3 ? cur[o + 1] : cur[o], B = ch >= 3 ? cur[o + 2] : cur[o];
            lum[y * w + x] = 0.299 * R + 0.587 * G + 0.114 * B;
        }
        prev.set(cur);
    }
    return { w, h, lum };
}

async function shoot(page, clip) {
    return decodePngToLum(await page.screenshot({ clip }));
}

// Compare native vs SSAA reference. Splits the deviation into GRAIN (mean-removed high-freq error =
// the aliasing) and BIAS (mean luminance shift vs truth = e.g. a normal-AA over-brightening at grazing
// NdL). Plus native HF (Laplacian) energy, reference-free.
function grainMetrics(nat, ref) {
    const n = Math.min(nat.lum.length, ref.lum.length);
    let mN = 0, mR = 0;
    for (let k = 0; k < n; k++) { mN += nat.lum[k]; mR += ref.lum[k]; }
    mN /= n; mR /= n;
    let se = 0, seG = 0;
    for (let k = 0; k < n; k++) {
        const e = nat.lum[k] - ref.lum[k];
        se += e * e;
        const g = nat.lum[k] - mN - (ref.lum[k] - mR); // de-biased → pure grain deviation
        seG += g * g;
    }
    let hf = 0, hn = 0;
    for (let y = 1; y < nat.h - 1; y++)
        for (let x = 1; x < nat.w - 1; x++) {
            const c = nat.lum[y * nat.w + x];
            const lap = 4 * c - nat.lum[y * nat.w + x - 1] - nat.lum[y * nat.w + x + 1] -
                nat.lum[(y - 1) * nat.w + x] - nat.lum[(y + 1) * nat.w + x];
            hf += lap * lap; hn++;
        }
    return { rmse: Math.sqrt(se / n), grain: Math.sqrt(seG / n), bias: mN - mR, hf: Math.sqrt(hf / hn), meanLum: mN };
}

const browser = await chromium.launch({
    headless: false,
    args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit']
});
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
page.on('console', (m) => { if (/device lost|fatal/i.test(m.text())) console.log('  ⚠', m.text().slice(0, 70)); });

try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => window.__world42Bench?.poseGrazing && window.__world42Perf?.getPlanets().length > 0,
        { timeout: 30000 }
    );
    await page.evaluate(() => window.__world42Perf.enableCapture(true));

    const pose = await page.evaluate(
        ({ planet, altKm, sunElevDeg, pitchDeg }) => {
            window.__world42Perf.setHardwareScaling(1);
            return window.__world42Bench.poseGrazing({ planet, altKm, sunElevDeg, pitchDeg });
        },
        { planet: PLANET, altKm: ALT, sunElevDeg: SUN_ELEV, pitchDeg: PITCH }
    );
    console.log(
        `# grain_probe  ${pose.planet}  alt=${pose.altKm}km  sunElev=${pose.sunElevDeg.toFixed(1)}°  ` +
            `R=${pose.radiusSim}  camDist=${pose.camDistToCenter?.toFixed(1)}  ` +
            `band=[${BAND.join(',')}] → ${CLIP.width}x${CLIP.height}px  ssaa=${SSAA} (${Math.round(1 / (SSAA * SSAA))}x)`
    );

    // Converge topology at native res, then FREEZE it so native/SSAA share the same leaves.
    await sleep(2500);
    await page.evaluate(() => window.__world42Perf.setFreezeTopology(true));
    await sleep(300);

    mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: join(OUT_DIR, 'grain_pose.png') }); // full frame, for band tuning
    console.log('  pose screenshot → scripts/.bench/grain_pose.png  (tune --band against it)\n');

    if (SAVE_REF) {
        // Capture the SSAA band of the CURRENT build as a fixed AA-off ground-truth reference.
        await page.evaluate((s) => window.__world42Perf.setHardwareScaling(s), SSAA);
        await sleep(700);
        const ref = await shoot(page, CLIP);
        writeFileSync(REF_PATH, JSON.stringify({ w: ref.w, h: ref.h, lum: Array.from(ref.lum) }));
        console.log(`  saved AA-off SSAA reference (${ref.w}x${ref.h}) → scripts/.bench/grain_ref.json`);
        await page.evaluate(() => {
            window.__world42Perf.setHardwareScaling(1);
            window.__world42Perf.setFreezeTopology(false);
            window.__world42Bench.releasePose();
        });
        if (!KEEP) await browser.close().catch(() => {});
        console.log('done');
        process.exit(0);
    }

    let savedRef = null;
    if (USE_REF) {
        const j = JSON.parse(readFileSync(REF_PATH, 'utf8'));
        savedRef = { w: j.w, h: j.h, lum: Float32Array.from(j.lum) };
        console.log(`  ref = AA-off SSAA from grain_ref.json (${savedRef.w}x${savedRef.h})\n`);
    }

    console.log('  perfMask           grain    bias   totalRMSE   HF     meanLum');
    console.log('  ' + '-'.repeat(60));
    const rows = [];
    for (const mask of MASKS) {
        await page.evaluate((m) => { window.__terrainPerfMask = m | 0; }, mask);
        await page.evaluate(() => window.__world42Perf.setHardwareScaling(1));
        await sleep(500);
        const nat = await shoot(page, CLIP);
        let ref = savedRef;
        if (!ref) {
            await page.evaluate((s) => window.__world42Perf.setHardwareScaling(s), SSAA);
            await sleep(700);
            ref = await shoot(page, CLIP);
            await page.evaluate(() => window.__world42Perf.setHardwareScaling(1));
        }
        const r = grainMetrics(nat, ref);
        rows.push({ mask, ...r });
        const label = MASK_LABEL[mask] ?? `mask ${mask}`;
        console.log(
            `  ${label.padEnd(16)} ${r.grain.toFixed(2).padStart(6)}  ${(r.bias >= 0 ? '+' : '') + r.bias.toFixed(2)}`.padEnd(34) +
            `${r.rmse.toFixed(2).padStart(6)}   ${r.hf.toFixed(2).padStart(6)}   ${r.meanLum.toFixed(0).padStart(5)}`
        );
    }

    const base = rows.find((x) => x.mask === 0);
    if (base) {
        console.log('\n  Δ grain vs baseline (negative = that block is a grain SOURCE at grazing sun):');
        for (const r of rows) {
            if (r.mask === 0) continue;
            const d = r.grain - base.grain;
            console.log(`    ${(MASK_LABEL[r.mask] ?? 'mask ' + r.mask).padEnd(16)} grain ${(d >= 0 ? '+' : '') + d.toFixed(2)}  bias ${(r.bias >= 0 ? '+' : '') + r.bias.toFixed(2)}`);
        }
    }

    await page.evaluate(() => {
        window.__terrainPerfMask = 0;
        window.__world42Perf.setFreezeTopology(false);
        window.__world42Bench.releasePose();
    });
} catch (e) {
    console.log('ERROR:', String(e).slice(0, 200));
} finally {
    if (!KEEP) await browser.close().catch(() => {});
}
console.log('done');
