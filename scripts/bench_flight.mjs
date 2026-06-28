/**
 * World42 deterministic flight bench — runs the in-page `window.__world42Bench.run()` fixed
 * ground→orbit+yaw path (frozen spin) while sampling whole-GPU power (nvidia-smi) in parallel, then
 * aggregates per phase (ground / climb) and DIFFS against a saved baseline so an optimization can be
 * compared apples-to-apples on the exact same camera motion.
 *
 * Usage (dev server must be running):
 *   node scripts/bench_flight.mjs --label before                 # writes scripts/.bench/before.json
 *   node scripts/bench_flight.mjs --label after --baseline before # writes after.json + prints diff
 * Flags: --url, --planet <suffix>, --frames <n>, --label <name>, --baseline <name>, --keep.
 *
 * Determinism: the path is FRAME-INDEXED in-page (one pose per rendered frame) with the planet spin
 * frozen, so the trajectory is identical regardless of fps. fps is vsync-capped → read power, not fps.
 * Requires an NVIDIA GPU (nvidia-smi on PATH). See .claude/skills/world42-perf-probe/SKILL.md.
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(HERE, '.bench');

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
}
const URL = arg('url', 'http://localhost:19000/?system=Dev&planet=Moon');
const PLANET = arg('planet', 'Moon');
const FRAMES = parseInt(arg('frames', '720'), 10);
const LABEL = arg('label', 'run');
const BASELINE = arg('baseline', null);
const KEEP = arg('keep', false) === true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const p90 = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };

function gpu() {
    try {
        const o = execSync('nvidia-smi --query-gpu=utilization.gpu,power.draw --format=csv,noheader,nounits',
            { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const [u, pw] = o.split(',').map((s) => parseFloat(s));
        return { u, pw };
    } catch { return null; }
}

// Aggregate per-frame metrics + aligned power for one phase ('ground'|'climb'|null=all).
function agg(frames, power, phase) {
    const f = phase ? frames.filter((x) => x.phase === phase) : frames;
    if (!f.length) return null;
    const t0 = f[0].t, t1 = f[f.length - 1].t;
    const pw = power.filter((p) => p.t >= t0 && p.t <= t1);
    return {
        n: f.length,
        powerW: Math.round(med(pw.map((x) => x.pw))),
        util: Math.round(med(pw.map((x) => x.u))),
        leaves: Math.round(med(f.map((x) => x.leaves))),
        frameMs: +med(f.map((x) => x.frameMs)).toFixed(2),
        topoMs: +med(f.map((x) => x.topoMs)).toFixed(3),
        evalMs: +med(f.map((x) => x.evalMs)).toFixed(3),
        compactMs: +med(f.map((x) => x.compactMs)).toFixed(3),
        topoP90: +p90(f.map((x) => x.topoMs)).toFixed(3)
    };
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
let alive = true;
page.on('close', () => { alive = false; });
page.on('console', (m) => { if (/hung|device lost|fatal/i.test(m.text())) console.log('  ⚠', m.text().slice(0, 70)); });

let report = null;
try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__world42Bench && window.__world42Perf?.getPlanets().length > 0, { timeout: 30000 });
    await page.evaluate(() => window.__world42Perf.enableCapture(true));

    // Warm up: park near the ground and let initial convergence happen before the timed flight.
    const planet = (await page.evaluate(() => window.__world42Perf.getPlanets()))[0];
    const [cx, cy, cz] = planet.center; const R = planet.radiusSim;
    await page.evaluate(({ cx, cy, cz, R }) => {
        window.__world42Perf.setHardwareScaling(1);
        window.__world42Perf.setCameraDoublePos(cx, cy + R + 0.05, cz);
    }, { cx, cy, cz, R });
    await sleep(5000);

    console.log(`# bench_flight  ${URL}  planet~${PLANET}  frames=${FRAMES}  label=${LABEL}`);
    console.log('  (replaying deterministic ground→orbit+yaw, sampling nvidia-smi…)');

    // Sample whole-GPU power in parallel while the in-page flight runs.
    const power = [];
    const sampler = setInterval(() => { const g = gpu(); if (g) power.push({ t: Date.now(), ...g }); }, 250);
    const result = await page.evaluate((frames) => window.__world42Bench.run({ frames, planet: undefined }), FRAMES);
    clearInterval(sampler);

    const ground = agg(result.frames, power, 'ground');
    const climb = agg(result.frames, power, 'climb');
    const all = agg(result.frames, power, null);
    report = { label: LABEL, meta: result.meta, frames: result.frames.length, ground, climb, all };

    mkdirSync(BENCH_DIR, { recursive: true });
    const outPath = join(BENCH_DIR, `${LABEL}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2));

    const row = (name, a) => a && console.log(
        `  ${name.padEnd(7)} pwr ${String(a.powerW).padStart(3)}W util ${String(a.util).padStart(3)}%  ` +
        `leaves ${String(a.leaves).padStart(6)}  frame ${a.frameMs.toFixed(2)}ms  ` +
        `ocbt[topo ${a.topoMs} eval ${a.evalMs} compact ${a.compactMs}]ms`);
    console.log(`\n## ${LABEL}  (per phase, medians; power = whole-GPU)`);
    row('ground', ground); row('climb', climb); row('all', all);
    console.log(`\n  saved → scripts/.bench/${LABEL}.json`);

    if (BASELINE) {
        const basePath = join(BENCH_DIR, `${BASELINE}.json`);
        if (existsSync(basePath)) {
            const base = JSON.parse(readFileSync(basePath, 'utf8'));
            const pct = (b, a) => (b ? ((a - b) / b * 100) : 0);
            const diffRow = (name, b, a) => b && a && console.log(
                `  ${name.padEnd(7)} power ${b.powerW}→${a.powerW}W (${pct(b.powerW, a.powerW) >= 0 ? '+' : ''}${pct(b.powerW, a.powerW).toFixed(0)}%)  ` +
                `frame ${b.frameMs}→${a.frameMs}ms  topo ${b.topoMs}→${a.topoMs}ms  eval ${b.evalMs}→${a.evalMs}ms`);
            console.log(`\n## DIFF vs baseline '${BASELINE}'  (negative = improvement)`);
            diffRow('ground', base.ground, ground);
            diffRow('climb', base.climb, climb);
            diffRow('all', base.all, all);
        } else {
            console.log(`\n  (baseline '${BASELINE}' not found at ${basePath} — run with --label ${BASELINE} first)`);
        }
    }
} catch (e) {
    console.log('ERROR:', String(e).slice(0, 160));
} finally {
    if (!KEEP) await browser.close().catch(() => {});
}
console.log('done');
