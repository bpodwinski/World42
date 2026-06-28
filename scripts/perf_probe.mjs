/**
 * World42 GPU/CPU perf probe — headed Playwright harness.
 *
 * WHY headed: headless Chrome throttles requestAnimationFrame to 30 fps and exposes no working
 * WebGPU timestamp queries, so in-app `gpuMs` reads garbage. A headed window renders on the real
 * GPU at the real refresh rate, and we read load from the OUTSIDE (nvidia-smi + OS CPU counters)
 * instead of trusting the broken in-app timer.
 *
 * It drives the app through the `window.__world42Perf` debug API (setup_runtime.ts), parks the
 * camera in a named scenario, sweeps a knob, and per knob value samples four metric families:
 *   - GPU       : nvidia-smi (util / mem-util / mem-used / power / graphics clock)
 *   - CPU app   : summed CPU-seconds of the Playwright Chromium processes (Get-Process)
 *   - CPU rndr  : renderer main-thread busy time via CDP Performance.getMetrics (TaskDuration)
 *   - structure : getStats().cbt (leafCount) + drawCalls, sampled once (cheap)
 *
 * Usage (from the repo root):
 *   node scripts/perf_probe.mjs --scenario ground-drift --knob rebakeEvery=1,3,6
 *   node scripts/perf_probe.mjs --scenario ground-still  --knob hwScale=1,0.7,0.5
 *   node scripts/perf_probe.mjs --scenario ground-drift  --knob df64NearKm=0.05,2,20
 *   node scripts/perf_probe.mjs --scenario ground-still  --knob perfMask=0,2,31
 *   node scripts/perf_probe.mjs --scenario ground-still  --freeze --knob perfMask=0,4,8,16
 *   node scripts/perf_probe.mjs --scenario orbit --planet 1 --window 6
 *
 * --freeze pins OCBT topology (after the initial convergence) so a perfMask sweep runs at a CONSTANT
 * leaf count — the clean way to attribute per-block FRAGMENT cost. The leaf min–max spread is reported
 * so you can confirm the freeze held (spread ~0). Use it with --scenario ground-still.
 *
 * Flags: --url, --planet <i>, --scenario, --knob <name=v1,v2,..>, --window <sec>, --hwScale <base>,
 *        --freeze, --headless, --keep (don't close the browser at the end).
 *
 * Requires: a running dev server (npm run serve), an NVIDIA GPU (nvidia-smi on PATH), Windows
 * PowerShell for the CPU-app counter. See .claude/skills/world42-perf-probe/SKILL.md.
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import os from 'node:os';

// ---- CLI -------------------------------------------------------------------------------------
function parseArgs(argv) {
    const a = { url: 'http://localhost:19000/?system=Dev&planet=Moon', planet: 0, scenario: 'ground-drift', knob: null, window: 5, hwScale: 1, headless: false, keep: false, freeze: false };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--url') a.url = next();
        else if (k === '--planet') a.planet = parseInt(next(), 10);
        else if (k === '--scenario') a.scenario = next();
        else if (k === '--knob') a.knob = next();
        else if (k === '--window') a.window = parseFloat(next());
        else if (k === '--hwScale') a.hwScale = parseFloat(next());
        else if (k === '--freeze') a.freeze = true;
        else if (k === '--headless') a.headless = true;
        else if (k === '--keep') a.keep = true;
    }
    return a;
}
const args = parseArgs(process.argv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORES = os.cpus().length;

// scenario -> { altKm: number | 'r*<f>', drift: units/frame }. Drift uses nudgeCameraDoublePos
// (no LOD reset) so the OCBT drift gate / re-bake throttle engages like real piloting.
const SCENARIOS = {
    'ground-still': { altKm: 0.06, drift: 0 },
    'ground-drift': { altKm: 0.06, drift: 0.025 },
    'ground-fly': { altKm: 0.06, drift: 1.5 },
    'low-orbit': { altKm: 'r*0.5', drift: 0 },
    orbit: { altKm: 'r*3', drift: 0 }
};

// Supported knob names (applied in-page by applyKnob()).
const KNOBS = ['perfMask', 'rebakeEvery', 'df64NearKm', 'hwScale'];
const applyKnob = (page, name, v) =>
    page.evaluate(({ name, v }) => {
        switch (name) {
            case 'perfMask': window.__ocbtPerfMask = v | 0; break;
            case 'rebakeEvery': window.__ocbtRebakeEvery = v; break;
            case 'df64NearKm': window.__ocbtDf64NearKm = v; break;
            case 'hwScale': window.__world42Perf.setHardwareScaling(v); break;
        }
    }, { name, v });

// ---- external samplers -----------------------------------------------------------------------
function gpuSample() {
    try {
        const out = execSync('nvidia-smi --query-gpu=utilization.gpu,utilization.memory,memory.used,power.draw,clocks.gr --format=csv,noheader,nounits', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const [u, mu, mem, pw, clk] = out.split(',').map((s) => parseFloat(s));
        return { u, mu, mem, pw, clk };
    } catch { return null; }
}

// Summed CPU-seconds of the Playwright Chromium processes (path filter isolates them from any
// other Chrome the user has open). Diff across the window / (wall * cores) = average app CPU%.
function cpuAppSeconds() {
    try {
        const ps = `(Get-Process chrome,chromium -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' } | Measure-Object CPU -Sum).Sum`;
        const out = execSync(`powershell.exe -NoProfile -NonInteractive -Command "${ps}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        return out ? parseFloat(out) : 0;
    } catch { return null; }
}

function median(a) { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }
function pct(a, p) { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

// ---- main ------------------------------------------------------------------------------------
// vsync off → the GPU runs flat-out so util/power reflect TRUE load (vsync would let it idle between presents).
const browser = await chromium.launch({
    headless: args.headless,
    args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit']
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const cdp = await browser.newBrowserCDPSession().catch(() => null);
const pageCdp = await page.context().newCDPSession(page);
await pageCdp.send('Performance.enable').catch(() => {});

let lost = false;
page.on('console', (m) => { if (/hung|device lost|fatal/i.test(m.text())) { lost = true; console.log('  ⚠ ', m.text().slice(0, 70)); } });

await page.goto(args.url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__world42Perf?.nudgeCameraDoublePos && window.__world42Perf.getPlanets().length > 0, { timeout: 30000 });
await page.evaluate(() => window.__world42Perf.enableCapture(true));
const engine = await page.evaluate(() => (window.__world42Perf.getStats().osGpu, document.querySelector('canvas') ? 'webgpu?' : '?'));

const planets = await page.evaluate(() => window.__world42Perf.getPlanets());
const planet = planets[Math.min(args.planet, planets.length - 1)];
const [cx, cy, cz] = planet.center;
const R = planet.radiusSim;
const scn = SCENARIOS[args.scenario];
if (!scn) { console.error('unknown scenario; choose from:', Object.keys(SCENARIOS).join(', ')); await browser.close(); process.exit(1); }
const altKm = typeof scn.altKm === 'string' ? R * parseFloat(scn.altKm.split('*')[1]) : scn.altKm;

console.log(`# perf_probe  planet=${planet.key} R=${R}  scenario=${args.scenario} (alt=${altKm.toFixed(2)} drift=${scn.drift}/f)  window=${args.window}s  cores=${CORES}`);

// Park camera: above the surface along +y, looking toward a grazing horizon point.
async function park() {
    await page.evaluate(({ cx, cy, cz, R, alt }) => {
        const P = window.__world42Perf;
        P.setCameraDoublePos(cx, cy + R + alt, cz);
        P.lookAtDoublePos(cx, cy + R * 0.985, cz + R * 0.5);
    }, { cx, cy, cz, R, alt: altKm });
}
const startDrift = (spd) => page.evaluate((s) => { window.__driftOn = true; const step = () => { if (!window.__driftOn) return; window.__world42Perf.nudgeCameraDoublePos(0, 0, s); requestAnimationFrame(step); }; requestAnimationFrame(step); }, spd);
const stopDrift = () => page.evaluate(() => { window.__driftOn = false; });
const rendererTaskSec = async () => { const m = await pageCdp.send('Performance.getMetrics'); const t = m.metrics.find((x) => x.name === 'TaskDuration'); return t ? t.value : null; };

// Knob sweep.
const [knobName, knobVals] = args.knob ? args.knob.split('=') : [null, null];
const values = knobVals ? knobVals.split(',').map((v) => (v.includes('.') ? parseFloat(v) : parseInt(v, 10))) : [null];
if (knobName && !KNOBS.includes(knobName)) { console.error('unknown knob; choose from:', KNOBS.join(', ')); await browser.close(); process.exit(1); }

await page.evaluate((s) => window.__world42Perf.setHardwareScaling(s), args.hwScale);
await park();
await sleep(3000);

// --freeze: pin the topology AFTER the initial convergence so the perfMask sweep below runs at a
// constant leaf count (clean fragment attribution). The leaf min–max spread reported per row confirms
// the freeze held. Released at the end so the dev session isn't left frozen.
if (args.freeze) {
    await page.evaluate(() => { window.__ocbtFreezeTopology = true; });
    console.log('  (topology FROZEN — leaf set pinned; spread should read ~0 below)');
}

console.log(`\n${(knobName || 'baseline').padEnd(14)} | GPU%(med/p90/max)  Gmem%  Vram  Pwr  Clk | CPUapp%  CPUrndr% | fps  leaves±spread  draws`);
console.log('-'.repeat(104));

for (const v of values) {
    if (lost) break;
    if (knobName) await applyKnob(page, knobName, v);
    await stopDrift();
    await sleep(1500);                      // settle still
    if (scn.drift > 0) await startDrift(scn.drift);
    await sleep(2000);                      // converge into the regime

    const cpuStart = cpuAppSeconds();
    const rndrStart = await rendererTaskSec();
    const tStart = Date.now();
    const gu = [];
    const lv = []; // leaf-count samples across the window → exposes topology drift (spread ~0 when frozen)
    const ticks = Math.max(8, Math.round((args.window * 1000) / 250));
    for (let i = 0; i < ticks; i++) {
        const g = gpuSample(); if (g) gu.push(g);
        const lf = await page.evaluate(() => window.__world42Perf.getStats().cbt?.leafCount ?? 0);
        if (lf) lv.push(lf);
        await sleep(250);
    }
    const wallSec = (Date.now() - tStart) / 1000;
    const cpuEnd = cpuAppSeconds();
    const rndrEnd = await rendererTaskSec();
    const snap = await page.evaluate(() => { const s = window.__world42Perf.getStats(); return { fps: s.fps, leaves: s.cbt?.leafCount ?? 0, draws: s.drawCalls ?? 0 }; });
    await stopDrift();
    await sleep(800);

    const U = gu.map((x) => x.u);
    const cpuApp = cpuStart != null && cpuEnd != null ? ((cpuEnd - cpuStart) / (wallSec * CORES)) * 100 : null;
    const cpuRndr = rndrStart != null && rndrEnd != null ? ((rndrEnd - rndrStart) / wallSec) * 100 : null;
    const f = (x, d = 0) => (x == null ? '  - ' : x.toFixed(d));
    const last = gu[gu.length - 1] || {};
    // Leaf count med + min–max spread across the window: a non-trivial spread means topology drifted
    // during the sample, so any power delta is partly leaf-count, not the swept knob. ~0 when --freeze.
    const lMed = lv.length ? median(lv) : snap.leaves;
    const lSpread = lv.length ? Math.max(...lv) - Math.min(...lv) : 0;
    console.log(
        `${String(v ?? '-').padEnd(14)} | ${f(median(U))}/${f(pct(U, 0.9))}/${f(Math.max(...U))}`.padEnd(34) +
        `   ${f(median(gu.map((x) => x.mu)))}   ${f(last.mem)}MB ${f(last.pw, 0)}W ${f(last.clk, 0)} | ` +
        `${f(cpuApp, 0).padStart(5)}    ${f(cpuRndr, 0).padStart(5)} | ${f(snap.fps, 0)}  ${String(lMed).padStart(7)}±${lSpread}  ${snap.draws}`
    );
}

if (args.freeze) await page.evaluate(() => { window.__ocbtFreezeTopology = false; });
console.log('\nNotes: GPU% from nvidia-smi (whole-GPU). CPUapp% = Playwright-Chromium CPU / (wall*cores).');
console.log('CPUrndr% = renderer main-thread busy (CDP TaskDuration). fps is vsync-capped at 60 — read GPU%/CPU% for headroom.');
console.log('leaves±spread: med ± (max−min) over the window; a spread >~1% means topology drifted (use --freeze for a clean fragment sweep).');
if (!args.keep) await browser.close();
console.log('done');
