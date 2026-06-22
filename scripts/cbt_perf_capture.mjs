import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Deterministic headless CBT perf capture.
 *
 * Flies the camera along a fixed descent toward the first (or named) CBT planet
 * via the dev-only `window.__world42Perf` hook, samples per-frame timing + CBT
 * stats at each waypoint, and writes output/perf/<label>.json.
 *
 * Usage:
 *   node scripts/cbt_perf_capture.mjs --label baseline
 *   CBT_PLANET=Sol:Earth node scripts/cbt_perf_capture.mjs --label phase1
 *
 * Requires the `playwright` package (not a default dep). If missing, prints the
 * one-time install command and exits 2 — so the script is correct when present
 * without forcing a heavy dependency on everyone.
 *
 * Pair the result with: node scripts/cbt_perf_compare.mjs baseline <label>
 */

const argv = process.argv.slice(2);
function arg(name, fallback) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const label = arg('label', 'capture');
const planetKey = process.env.CBT_PLANET || arg('planet', '');
const defaultPort = process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : '19000';
let url = process.env.PW_URL || `http://localhost:${defaultPort}/`;
const autoServe = process.env.PW_AUTO_SERVE !== '0';

// Descent: camera distance from planet center as a multiple of planet radius.
const WAYPOINTS = [8, 5, 3, 2, 1.4, 1.08];
const SETTLE_MS = 1200; // let LOD churn settle before sampling
const SAMPLE_MS = 1500; // capture window per waypoint

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

async function main() {
    const chromium = await loadPlaywright();
    if (!chromium) {
        console.error(
            '[cbt-perf] Playwright is not installed. Enable scripted capture with:\n' +
                '    npm i -D playwright && npx playwright install chromium\n' +
                '  (Or use the in-app perf HUD: press P in the running app.)'
        );
        process.exit(2);
    }

    let devServer = null;
    if (!(await isReachable(url)) && autoServe) {
        console.log(`[cbt-perf] ${url} not reachable, starting dev server...`);
        devServer = await startDevServer();
        url = devServer.url;
        await sleep(500);
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

    const frameSamples = [];
    const gpuSamples = [];
    const classifySamples = [];
    let maxLeaves = 0;
    let totalRebuilds = 0;
    let rebuildMsSum = 0;

    try {
        console.log(`[cbt-perf] url=${url} label=${label}`);
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });

        // Wait for the dev hook + at least one CBT planet.
        await page.waitForFunction(
            () => !!window.__world42Perf && window.__world42Perf.getPlanets().length > 0,
            { timeout: 60000 }
        );

        const planets = await page.evaluate(() => window.__world42Perf.getPlanets());
        const planet = planetKey ? planets.find((p) => p.key === planetKey) : planets[0];
        if (!planet) {
            throw new Error(
                `no CBT planet found (key=${planetKey || '<first>'}). available=${planets.map((p) => p.key).join(',')}`
            );
        }
        console.log(`[cbt-perf] planet=${planet.key} radius=${planet.radiusSim}`);

        await page.evaluate(() => window.__world42Perf.enableCapture(true));

        for (const mult of WAYPOINTS) {
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

            const wp = await page.evaluate(async (sampleMs) => {
                const hook = window.__world42Perf;
                const frames = [];
                const gpu = [];
                const classify = [];
                let maxLeaves = 0;
                let rebuilds = 0;
                let rebuildMsSum = 0;
                let last = performance.now();
                const end = last + sampleMs;
                await new Promise((resolve) => {
                    const tick = (now) => {
                        frames.push(now - last);
                        last = now;
                        const s = hook.getStats();
                        gpu.push(s.gpuMs);
                        classify.push(s.cbt.classifyMs);
                        if (s.cbt.leafCount > maxLeaves) maxLeaves = s.cbt.leafCount;
                        if (s.cbt.rebuildMs > 0) {
                            rebuilds++;
                            rebuildMsSum += s.cbt.rebuildMs;
                        }
                        if (now < end) requestAnimationFrame(tick);
                        else resolve();
                    };
                    requestAnimationFrame(tick);
                });
                return { frames, gpu, classify, maxLeaves, rebuilds, rebuildMsSum };
            }, SAMPLE_MS);

            frameSamples.push(...wp.frames);
            gpuSamples.push(...wp.gpu);
            classifySamples.push(...wp.classify);
            maxLeaves = Math.max(maxLeaves, wp.maxLeaves);
            totalRebuilds += wp.rebuilds;
            rebuildMsSum += wp.rebuildMsSum;
            console.log(`[cbt-perf]   waypoint x${mult}: leaves=${wp.maxLeaves} rebuilds=${wp.rebuilds}`);
        }
    } finally {
        await browser.close();
        if (devServer?.child) devServer.child.kill();
    }

    const frameSorted = [...frameSamples].sort((a, b) => a - b);
    const gpuSorted = [...gpuSamples].sort((a, b) => a - b);
    const classifyMax = classifySamples.length ? Math.max(...classifySamples) : 0;

    const result = {
        label,
        url,
        capturedAtMs: Number(process.env.PERF_STAMP_MS) || null,
        waypoints: WAYPOINTS,
        settleMs: SETTLE_MS,
        sampleMs: SAMPLE_MS,
        samples: frameSamples.length,
        summary: {
            frameMsP50: percentile(frameSorted, 50),
            frameMsP95: percentile(frameSorted, 95),
            gpuMsP50: percentile(gpuSorted, 50),
            maxLeaves,
            totalRebuilds,
            meanRebuildMs: totalRebuilds ? rebuildMsSum / totalRebuilds : 0,
            maxClassifyMs: classifyMax,
        },
    };

    mkdirSync(join(process.cwd(), 'output', 'perf'), { recursive: true });
    const out = join(process.cwd(), 'output', 'perf', `${label}.json`);
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`[cbt-perf] wrote ${out}`);
    console.log(`[cbt-perf] summary:`, result.summary);
}

main().catch((err) => {
    console.error(`[cbt-perf] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
