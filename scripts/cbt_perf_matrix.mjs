import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Run the per-altitude perf capture for ALL four LOD backends against the same
 * dedicated benchmark planet, then print side-by-side comparison tables
 * (one row per altitude, one column per backend).
 *
 * Starts a single dev server, then runs scripts/cbt_perf_capture.mjs once per
 * backend (so each writes output/perf/<algo>.json), and tabulates the results.
 *
 * Usage:
 *   node scripts/cbt_perf_matrix.mjs
 *   node scripts/cbt_perf_matrix.mjs --algos "cdlod,cbt-ocbt" --altitudes "20,3,1.08"
 *
 * Requires Playwright (the capture prints the install hint if missing).
 */

const argv = process.argv.slice(2);
function arg(name, fallback) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const ALGOS = arg('algos', 'cdlod,cbt-gpu,cbt-cpu,cbt-ocbt')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const altitudesArg = arg('altitudes', '');
const defaultPort = process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : '19000';
let url = process.env.PW_URL || `http://localhost:${defaultPort}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
            const m = String(line).match(/https?:\/\/localhost:(\d+)\//);
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

function runCapture(algo, serverUrl) {
    return new Promise((resolve, reject) => {
        const args = ['scripts/cbt_perf_capture.mjs', '--lod', algo, '--label', algo];
        if (altitudesArg) args.push('--altitudes', altitudesArg);
        const child = spawn(process.execPath, args, {
            cwd: process.cwd(),
            env: { ...process.env, PW_URL: serverUrl, PW_AUTO_SERVE: '0' },
            stdio: 'inherit',
        });
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else if (code === 2) reject(new Error('Playwright not installed (see hint above)'));
            else reject(new Error(`capture for ${algo} exited code=${code}`));
        });
    });
}

function loadResult(algo) {
    const path = join(process.cwd(), 'output', 'perf', `${algo}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
}

function fmt(n) {
    if (n === undefined || n === null) return '-';
    return typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : String(n);
}

/** Print one comparison table: rows = altitude, cols = algo, value = pick(record). */
function printTable(title, results, pick, lowerIsBetter = true) {
    console.log(`\n=== ${title} ===`);
    const algos = results.map((r) => r.algo);
    const header = ['altitude', ...algos];
    const rows = [header];

    const mults = results[0]?.data.byAltitude.map((w) => w.mult) ?? [];
    for (const mult of mults) {
        const cells = [`x${mult}`];
        const vals = results.map((r) => {
            const w = r.data.byAltitude.find((x) => x.mult === mult);
            return w ? pick(w) : null;
        });
        const valid = vals.filter((v) => typeof v === 'number' && Number.isFinite(v));
        const best = valid.length
            ? lowerIsBetter
                ? Math.min(...valid)
                : Math.max(...valid)
            : null;
        for (const v of vals) cells.push(v === best && best !== null ? `${fmt(v)} *` : fmt(v));
        rows.push(cells);
    }

    const widths = header.map((_u, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    rows.forEach((r, i) => {
        console.log(r.map((c, j) => String(c).padEnd(widths[j])).join('  '));
        if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    });
}

async function main() {
    let devServer = null;
    if (!(await isReachable(url))) {
        console.log(`[matrix] ${url} not reachable, starting dev server...`);
        devServer = await startDevServer();
        url = devServer.url;
        await sleep(500);
    }
    console.log(`[matrix] url=${url} algos=${ALGOS.join(', ')}`);

    try {
        for (const algo of ALGOS) {
            console.log(`\n[matrix] === capturing ${algo} ===`);
            await runCapture(algo, url);
        }
    } finally {
        if (devServer?.child) devServer.child.kill();
    }

    const results = ALGOS.map((algo) => ({ algo, data: loadResult(algo) })).filter((r) => r.data);
    if (results.length === 0) {
        console.error('[matrix] no result files produced.');
        process.exit(1);
    }

    const gpuEverywhere = results.every((r) => r.data.gpuAvailable);
    if (gpuEverywhere) {
        printTable('GPU time p50 (ms) — lower is better', results, (w) => w.gpuMsP50);
    } else {
        console.log('\n[matrix] GPU timestamps unavailable for some backends — primary = frame time.');
    }
    printTable('Frame time p50 (ms) — lower is better', results, (w) => w.frameMsP50);
    printTable('Triangles rendered (k) — load, not better/worse', results, (w) => Math.round(w.triangles / 1000), false);
    printTable('Draw calls — lower is better', results, (w) => w.drawCalls);

    console.log('\n[matrix] * = best (per row). Compare cost columns AGAINST the triangle-load row.');
    console.log(`[matrix] result files: output/perf/{${ALGOS.join(',')}}.json`);
}

main().catch((err) => {
    console.error(`[matrix] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
