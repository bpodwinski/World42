import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Diff two TERRAIN perf capture JSON files (produced by terrain_perf_capture.mjs).
 *
 * Usage:
 *   node scripts/terrain_perf_compare.mjs <baseline.json> <candidate.json>
 *   node scripts/terrain_perf_compare.mjs baseline phase1     # resolves output/perf/<name>.json
 */

function resolvePath(arg) {
    if (arg.endsWith('.json')) return arg;
    return `output/perf/${arg}.json`;
}

function load(arg) {
    const path = resolvePath(arg);
    return { path, data: JSON.parse(readFileSync(path, 'utf8')) };
}

function pct(base, cand) {
    if (base === 0) return cand === 0 ? '0%' : 'n/a';
    const d = ((cand - base) / base) * 100;
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}%`;
}

function fmt(n) {
    if (n === undefined || n === null) return '-';
    return typeof n === 'number' ? n.toFixed(2) : String(n);
}

const [, , baseArg, candArg] = process.argv;
if (!baseArg || !candArg) {
    console.error('Usage: node scripts/terrain_perf_compare.mjs <baseline> <candidate>');
    process.exit(1);
}

const base = load(baseArg);
const cand = load(candArg);

// Metrics to compare: lower-is-better unless noted.
const METRICS = [
    ['frame p50 (ms)', (d) => d.summary.frameMsP50],
    ['frame p95 (ms)', (d) => d.summary.frameMsP95],
    ['gpu p50 (ms)', (d) => d.summary.gpuMsP50],
    ['max leaves', (d) => d.summary.maxLeaves],
    ['total rebuilds', (d) => d.summary.totalRebuilds],
    ['mean rebuild (ms)', (d) => d.summary.meanRebuildMs],
    ['max classify (ms)', (d) => d.summary.maxClassifyMs],
];

console.log(`\nbaseline : ${base.path}  (label=${base.data.label})`);
console.log(`candidate: ${cand.path}  (label=${cand.data.label})\n`);

const rows = [['metric', 'baseline', 'candidate', 'delta']];
for (const [name, get] of METRICS) {
    const b = get(base.data);
    const c = get(cand.data);
    rows.push([name, fmt(b), fmt(c), pct(b ?? 0, c ?? 0)]);
}

const widths = rows[0].map((_unused, i) => Math.max(...rows.map((r) => String(r[i]).length)));
for (let i = 0; i < rows.length; i++) {
    const line = rows[i].map((cell, j) => String(cell).padEnd(widths[j])).join('  ');
    console.log(line);
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '));
}
console.log('');
