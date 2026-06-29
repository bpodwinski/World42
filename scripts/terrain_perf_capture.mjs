import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Deterministic headless LOD perf capture — PER ALTITUDE.
 *
 * Flies the camera along a fixed descent toward the benchmark planet via the
 * dev-only `window.__world42Perf` hook, and at EACH altitude waypoint samples
 * frame/GPU time + draw load + leaf count. Writes output/perf/<label>.json with
 * a `byAltitude[]` breakdown (the headline) plus a global `summary`.
 *
 * Backend selection: `--lod <algo>` appends `?bench=<algo>` to the URL, which
 * makes the app load ONLY the dedicated Benchmark planet on that backend
 * (cdlod | terrain-cpu | terrain-gpu | terrain-terrain) — see src/.../bench_override.ts.
 *
 * Usage:
 *   node scripts/terrain_perf_capture.mjs --lod terrain-terrain --label terrain-terrain
 *   node scripts/terrain_perf_capture.mjs --lod cdlod --altitudes "20,8,3,1.08"
 *
 * Requires the `playwright` package (not a default dep). If missing, prints the
 * one-time install command and exits 2.
 *
 * Compare runs with: node scripts/terrain_perf_matrix.mjs   (runs all 4 backends)
 */

const argv = process.argv.slice(2);
function arg(name, fallback) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const lod = arg('lod', ''); // '' = whatever data.json says (no bench override)
const label = arg('label', lod || 'capture');
const planetKey = process.env.TERRAIN_PLANET || arg('planet', '');
const defaultPort = process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : '19000';
let url = process.env.PW_URL || `http://localhost:${defaultPort}/`;
const autoServe = process.env.PW_AUTO_SERVE !== '0';
// CDP mode: connect to an ALREADY-RUNNING Chrome (started by the user in their
// interactive desktop session) so the bench runs on the real GPU. Headless /
// shell-spawned Chromium has no GPU process under RDP → no WebGPU. Start Chrome
// with:  chrome --remote-debugging-port=9222   then pass --cdp http://localhost:9222
const cdpUrl = process.env.PW_CDP || arg('cdp', '');

// Descent: camera distance from planet center as a multiple of planet radius.
const DEFAULT_WAYPOINTS = [20, 8, 5, 3, 2, 1.4, 1.08, 1.02];
const WAYPOINTS = arg('altitudes', '')
    ? arg('altitudes', '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
    : DEFAULT_WAYPOINTS;

// CPU/worker backends build geometry asynchronously, so they need more time to
// converge before a clean sample than the GPU paths.
const isAsyncBackend = lod === 'cdlod' || lod === 'terrain-cpu';
const SETTLE_MS = Number(arg('settle', isAsyncBackend ? '3000' : '1500'));
const SAMPLE_MS = Number(arg('sample', '1500'));
const WARMUP_MS = Number(arg('warmup', '4000')); // discarded: pipeline/shader compile + first churn

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
    for (const mod of ['playwright', '@playwright/test']) {
        try {
            const pw = await import(mod);
            return pw.chromium ?? pw.default?.chromium;
        } catch {
            /* try next */
        }
    }
    return null;
}

async function isReachable(target) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
        const res = await fetch(target, { method: 'GET', signal: controller.signal });
        return res.ok || res.status > 0;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

function startDevServer() {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['./node_modules/@rspack/cli/bin/rspack.js', 'serve'],
            {
                cwd: process.cwd(),
                env: { ...process.env, NODE_ENV: 'development', DEV_HOT: '0', PORT: defaultPort },
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );
        let resolved = false;
        const onChunk = (line) => {
            const text = String(line);
            const m = text.match(/https?:\/\/localhost:(\d+)\//);
            if (m && !resolved) {
                resolved = true;
                resolve({ child, url: `http://localhost:${m[1]}/` });
            }
        };
        child.stdout?.on('data', onChunk);
        child.stderr?.on('data', onChunk);
        child.on('exit', (code) => {
            if (!resolved) reject(new Error(`dev server exited before ready (code=${code})`));
        });
        setTimeout(() => {
            if (!resolved) {
                child.kill();
                reject(new Error('timed out waiting for dev server'));
            }
        }, 60000);
    });
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

function median(arr) {
    if (arr.length === 0) return 0;
    return percentile([...arr].sort((a, b) => a - b), 50);
}

function withBench(target) {
    if (!lod) return target;
    return target + (target.includes('?') ? '&' : '?') + `bench=${encodeURIComponent(lod)}`;
}

/** Position + aim the camera at a waypoint, then sample a window in-page. */
async function sampleWaypoint(page, planet, mult) {
    const [cx, cy, cz] = planet.center;
    const dist = planet.radiusSim * mult;
    const pos = [cx, cy, cz + dist];

    await page.evaluate(
        ({ pos, center }) => {
            window.__world42Perf.setCameraDoublePos(pos[0], pos[1], pos[2]);
            window.__world42Perf.lookAtDoublePos(center[0], center[1], center[2]);
        },
        { pos, center: planet.center }
    );

    await sleep(SETTLE_MS);

    return page.evaluate(async (sampleMs) => {
        const hook = window.__world42Perf;
        const frames = [];
        const gpu = [];
        const draws = [];
        const indices = [];
        let maxLeaves = 0;
        const end = performance.now() + sampleMs;
        await new Promise((resolve) => {
            const tick = (now) => {
                const s = hook.getStats();
                // Real instrumented CPU frame time (SceneInstrumentation), NOT the rAF
                // wall-clock delta — that is VSync-locked at ~16.7 ms and hides all cost.
                if (s.frameMs > 0) frames.push(s.frameMs);
                if (s.gpuMs > 0) gpu.push(s.gpuMs);
                draws.push(s.drawCalls);
                indices.push(s.activeIndices);
                if (s.terrain.leafCount > maxLeaves) maxLeaves = s.terrain.leafCount;
                if (now < end) requestAnimationFrame(tick);
                else resolve();
            };
            requestAnimationFrame(tick);
        });
        return { frames, gpu, draws, indices, maxLeaves };
    }, SAMPLE_MS);
}

async function main() {
    const chromium = await loadPlaywright();
    if (!chromium) {
        console.error(
            '[perf] Playwright is not installed. Enable scripted capture with:\n' +
                '    npm i -D playwright && npx playwright install chromium\n' +
                '  (Or use the in-app perf HUD: press P in the running app.)'
        );
        process.exit(2);
    }

    let devServer = null;
    if (!(await isReachable(url)) && autoServe) {
        console.log(`[perf] ${url} not reachable, starting dev server...`);
        devServer = await startDevServer();
        url = devServer.url;
        await sleep(500);
    }

    const pageUrl = withBench(url);
    let browser;
    let page;
    if (cdpUrl) {
        console.log(`[perf] connecting to existing Chrome over CDP: ${cdpUrl}`);
        browser = await chromium.connectOverCDP(cdpUrl);
        const ctx = browser.contexts()[0] ?? (await browser.newContext());
        page = await ctx.newPage();
        await page.setViewportSize({ width: 1920, height: 1080 });
    } else {
        // Headless Chromium has no WebGPU, so the GPU backends (terrain-gpu/terrain-terrain) can't run
        // there. PW_HEADLESS=0 launches a headed browser with WebGPU enabled (real GPU), the
        // only way to bench the GPU paths. Default stays headless for CPU-only / CI runs.
        const headless = process.env.PW_HEADLESS !== '0';
        const gpuArgs = headless
            ? []
            : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'];
        browser = await chromium.launch({ headless, args: gpuArgs });
        page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    }

    const byAltitude = [];
    const allFrames = [];
    const allGpu = [];
    let maxLeavesAll = 0;
    let maxIndicesAll = 0;

    try {
        console.log(`[perf] url=${pageUrl} label=${label} lod=${lod || '<data.json>'}`);
        await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });

        await page.waitForFunction(
            () => !!window.__world42Perf && window.__world42Perf.getPlanets().length > 0,
            { timeout: 60000 }
        );

        const planets = await page.evaluate(() => window.__world42Perf.getPlanets());
        const planet = planetKey ? planets.find((p) => p.key === planetKey) : planets[0];
        if (!planet) {
            throw new Error(
                `no planet found (key=${planetKey || '<first>'}). available=${planets.map((p) => p.key).join(',')}`
            );
        }
        console.log(`[perf] planet=${planet.key} radius=${planet.radiusSim}`);

        await page.evaluate(() => window.__world42Perf.enableCapture(true));

        // Warm-up at the farthest waypoint: compile pipelines / build first chunks,
        // then discard — the first frames after load are not representative.
        await page.evaluate(
            ({ pos, center }) => {
                window.__world42Perf.setCameraDoublePos(pos[0], pos[1], pos[2]);
                window.__world42Perf.lookAtDoublePos(center[0], center[1], center[2]);
            },
            {
                pos: [planet.center[0], planet.center[1], planet.center[2] + planet.radiusSim * WAYPOINTS[0]],
                center: planet.center,
            }
        );
        await sleep(WARMUP_MS);

        for (const mult of WAYPOINTS) {
            const wp = await sampleWaypoint(page, planet, mult);

            const frameSorted = [...wp.frames].sort((a, b) => a - b);
            const gpuSorted = [...wp.gpu].sort((a, b) => a - b);
            const drawCalls = Math.round(median(wp.draws));
            const activeIndices = Math.round(median(wp.indices));

            const record = {
                mult,
                frameMsP50: percentile(frameSorted, 50),
                frameMsP95: percentile(frameSorted, 95),
                gpuMsP50: percentile(gpuSorted, 50),
                gpuMsP95: percentile(gpuSorted, 95),
                drawCalls,
                activeIndices,
                triangles: Math.round(activeIndices / 3),
                leafCount: wp.maxLeaves,
                samples: wp.frames.length,
            };
            byAltitude.push(record);
            allFrames.push(...wp.frames);
            allGpu.push(...wp.gpu);
            maxLeavesAll = Math.max(maxLeavesAll, wp.maxLeaves);
            maxIndicesAll = Math.max(maxIndicesAll, activeIndices);
            console.log(
                `[perf]   x${mult}: gpu ${record.gpuMsP50.toFixed(2)}ms  frame ${record.frameMsP50.toFixed(2)}ms  ` +
                    `tris ${(record.triangles / 1000).toFixed(0)}k  draws ${drawCalls}  leaves ${wp.maxLeaves}`
            );
        }
    } finally {
        // In CDP mode, only close our own page — never the user's browser.
        if (cdpUrl) {
            await page.close().catch(() => {});
        } else {
            await browser.close();
        }
        if (devServer?.child) devServer.child.kill();
    }

    const frameSorted = [...allFrames].sort((a, b) => a - b);
    const gpuSorted = [...allGpu].sort((a, b) => a - b);
    const gpuAvailable = allGpu.some((v) => v > 0);

    const result = {
        label,
        lod: lod || null,
        url: pageUrl,
        capturedAtMs: Number(process.env.PERF_STAMP_MS) || null,
        gpuAvailable,
        waypoints: WAYPOINTS,
        settleMs: SETTLE_MS,
        sampleMs: SAMPLE_MS,
        warmupMs: WARMUP_MS,
        byAltitude,
        summary: {
            frameMsP50: percentile(frameSorted, 50),
            frameMsP95: percentile(frameSorted, 95),
            gpuMsP50: percentile(gpuSorted, 50),
            gpuMsP95: percentile(gpuSorted, 95),
            maxLeaves: maxLeavesAll,
            maxActiveIndices: maxIndicesAll,
        },
    };

    mkdirSync(join(process.cwd(), 'output', 'perf'), { recursive: true });
    const out = join(process.cwd(), 'output', 'perf', `${label}.json`);
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`[perf] wrote ${out}`);
    if (!gpuAvailable) {
        console.log('[perf] note: gpuMs was 0 for all samples (GPU timestamps unavailable headless) — use frameMs.');
    }
}

main().catch((err) => {
    console.error(`[perf] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
