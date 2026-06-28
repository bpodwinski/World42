/**
 * World42 deterministic flight bench — replays the fixed ground→orbit path (frozen spin phase) while
 * sampling whole-GPU power (nvidia-smi) in parallel, then aggregates per phase (ground / climb).
 *
 * Modes:
 *   default  : one flight → scripts/.bench/<label>.json (+ diff vs --baseline).
 *   --repeat N: N flights of the same config → median ± stddev (is a delta signal or noise?).
 *
 * Each flight RESETS OCBT topology first (in-page), so back-to-back flights replay an identical
 * leaf-count trajectory — no state leak from the previous flight. --frames is fixed (no wall-clock
 * reparam), so the path is byte-identical every run.
 *
 * Fragment per-block attribution is NOT done here: an in-flight perfMask sweep is confounded by
 * leaf-count variance between flights (each block appeared to "save" ~90 W — impossible). Use the
 * STILL probe with frozen topology instead (leaf set pinned → the delta is pure fragment):
 *   node scripts/perf_probe.mjs --scenario ground-still --freeze --knob perfMask=0,4,8,16
 *
 * Usage (dev server must be running):
 *   node scripts/bench_flight.mjs --label before
 *   node scripts/bench_flight.mjs --label after --baseline before
 *   node scripts/bench_flight.mjs --repeat 3 --frames 800
 * Flags: --url, --planet <suffix>, --frames <n>, --label, --baseline, --repeat <n>, --keep.
 *
 * Determinism: the path is FRAME-INDEXED in-page at a fixed fps cap with the planet spin frozen to a
 * FIXED phase, so the trajectory AND the terrain under it are identical every run. fps is capped → read
 * power (nvidia-smi) + LEAF COUNT + the in-engine OCBT compute buckets. Render-pass gpuMs is BROKEN
 * under Playwright (reads ~0) — never trust it; it is omitted from the output.
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
const FRAMES = parseInt(arg('frames', '2000'), 10);
const LABEL = arg('label', 'run');
const BASELINE = arg('baseline', null);
const REPEAT = Math.max(1, parseInt(arg('repeat', '1'), 10));
const KEEP = arg('keep', false) === true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sortNum = (a) => a.slice().sort((x, y) => x - y);
const med = (a) => (a.length ? sortNum(a)[a.length >> 1] : 0);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

function gpu() {
    try {
        const o = execSync('nvidia-smi --query-gpu=utilization.gpu,power.draw --format=csv,noheader,nounits',
            { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const [u, pw] = o.split(',').map((s) => parseFloat(s));
        return { u, pw };
    } catch { return null; }
}

// One flight (the in-page bench resets topology, then replays the fixed path); samples nvidia-smi in
// parallel. Returns { meta, frames, power }. perfMask stays 0 — fragment attribution lives in perf_probe.
async function runFlight(page, frames) {
    const power = [];
    const sampler = setInterval(() => { const g = gpu(); if (g) power.push({ t: Date.now(), ...g }); }, 250);
    const result = await page.evaluate((f) => window.__world42Bench.run({ frames: f }), frames);
    clearInterval(sampler);
    return { meta: result.meta, frames: result.frames, power };
}

// Aggregate per-frame metrics + power for one phase ('ground'|'climb'|null=all).
function agg(run, phase) {
    const f = phase ? run.frames.filter((x) => x.phase === phase) : run.frames;
    if (!f.length) return null;
    const t0 = f[0].t, t1 = f[f.length - 1].t;
    const pw = run.power.filter((p) => p.t >= t0 && p.t <= t1);
    return {
        n: f.length,
        powerW: Math.round(med(pw.map((x) => x.pw))),
        util: Math.round(med(pw.map((x) => x.u))),
        leaves: Math.round(med(f.map((x) => x.leaves))),
        frameMs: +med(f.map((x) => x.frameMs)).toFixed(2),
        gpuMs: +med(f.map((x) => x.gpuMs)).toFixed(2), // render-pass GPU ms (real browser only)
        topoMs: +med(f.map((x) => x.topoMs)).toFixed(3),
        evalMs: +med(f.map((x) => x.evalMs)).toFixed(3),
        compactMs: +med(f.map((x) => x.compactMs)).toFixed(3)
    };
}

const browser = await chromium.launch({
    headless: false,
    args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit']
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
let alive = true;
page.on('close', () => { alive = false; });
page.on('console', (m) => { if (/hung|device lost|fatal/i.test(m.text())) console.log('  ⚠', m.text().slice(0, 70)); });

try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__world42Bench && window.__world42Perf?.getPlanets().length > 0, { timeout: 30000 });
    await page.evaluate(() => window.__world42Perf.enableCapture(true));

    // Warm up: park near the ground so pipelines compile + the GPU clocks ramp before the timed flights.
    const planet = (await page.evaluate(() => window.__world42Perf.getPlanets()))[0];
    const [cx, cy, cz] = planet.center; const R = planet.radiusSim;
    await page.evaluate(({ cx, cy, cz, R }) => {
        window.__world42Perf.setHardwareScaling(1);
        window.__world42Perf.setCameraDoublePos(cx, cy + R + 0.05, cz);
    }, { cx, cy, cz, R });
    await sleep(5000);

    const rowFmt = (name, a) => a && console.log(
        `  ${name.padEnd(8)} pwr ${String(a.powerW).padStart(3)}W util ${String(a.util).padStart(3)}%  ` +
        `leaves ${String(a.leaves).padStart(6)}  frame ${a.frameMs}ms  ` +
        `ocbt[topo ${a.topoMs} eval ${a.evalMs} compact ${a.compactMs}]ms`);

    if (REPEAT > 1) {
        // ---- repeat ×N: median ± stddev so you know if a delta is signal -------------------------
        console.log(`# bench_flight REPEAT ×${REPEAT}  ${PLANET}  frames=${FRAMES}`);
        const runs = [];
        for (let r = 0; r < REPEAT && alive; r++) {
            const run = await runFlight(page, FRAMES);
            runs.push({ ground: agg(run, 'ground'), climb: agg(run, 'climb'), all: agg(run, null) });
            console.log(`  run ${r + 1}/${REPEAT} done`);
        }
        const summarize = (phase) => {
            const ms = runs.map((x) => x[phase]).filter(Boolean);
            const f = (k, d = 1) => `${med(ms.map((x) => x[k])).toFixed(d)}±${std(ms.map((x) => x[k])).toFixed(d)}`;
            console.log(`  ${phase.padEnd(7)} pwr ${f('powerW', 0)}W  leaves ${f('leaves', 0)}  ` +
                `frame ${f('frameMs', 2)}ms  topo ${f('topoMs', 3)}ms  eval ${f('evalMs', 3)}ms`);
        };
        console.log('\n## median ± stddev across runs (a delta smaller than ±stddev is noise)');
        summarize('ground'); summarize('climb'); summarize('all');
    } else {
        // ---- single flight (+ optional baseline diff) -------------------------------------------
        console.log(`# bench_flight  ${PLANET}  frames=${FRAMES}  label=${LABEL}`);
        const run = await runFlight(page, FRAMES);
        const ground = agg(run, 'ground'), climb = agg(run, 'climb'), all = agg(run, null);
        const report = { label: LABEL, meta: run.meta, ground, climb, all };
        mkdirSync(BENCH_DIR, { recursive: true });
        writeFileSync(join(BENCH_DIR, `${LABEL}.json`), JSON.stringify(report, null, 2));
        console.log(`\n## ${LABEL}  (per phase, medians; power = whole-GPU nvidia-smi; render-pass gpuMs omitted — broken under Playwright)`);
        rowFmt('ground', ground); rowFmt('climb', climb); rowFmt('all', all);
        console.log(`\n  saved → scripts/.bench/${LABEL}.json`);

        if (BASELINE) {
            const basePath = join(BENCH_DIR, `${BASELINE}.json`);
            if (existsSync(basePath)) {
                const base = JSON.parse(readFileSync(basePath, 'utf8'));
                const pct = (b, a) => (b ? ((a - b) / b * 100) : 0);
                const diffRow = (n, b, a) => b && a && console.log(
                    `  ${n.padEnd(7)} power ${b.powerW}→${a.powerW}W (${pct(b.powerW, a.powerW) >= 0 ? '+' : ''}${pct(b.powerW, a.powerW).toFixed(0)}%)  ` +
                    `leaves ${b.leaves}→${a.leaves}  topo ${b.topoMs}→${a.topoMs}ms  eval ${b.evalMs}→${a.evalMs}ms`);
                console.log(`\n## DIFF vs '${BASELINE}'  (negative = improvement; a leaves Δ means the power Δ is partly leaf-count, not the optimization)`);
                diffRow('ground', base.ground, ground);
                diffRow('climb', base.climb, climb);
                diffRow('all', base.all, all);
            } else {
                console.log(`\n  (baseline '${BASELINE}' not found — run with --label ${BASELINE} first)`);
            }
        }
    }
} catch (e) {
    console.log('ERROR:', String(e).slice(0, 160));
} finally {
    if (!KEEP) await browser.close().catch(() => {});
}
console.log('done');
