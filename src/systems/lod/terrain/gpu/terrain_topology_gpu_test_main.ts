/**
 * Dev-only WebGPU test page: cross-checks the TERRAIN GPU concurrent topology engine
 * (`TerrainTopologyKernel`, the WGSL port of update_utilities.hlsl) against the proven
 * sequential CPU oracle (`TerrainTopology`). Both are driven to a fixpoint by the SAME
 * deterministic, convention-invariant per-face target-level predicate (face bits 8..15
 * are identical in the reference and terrain_leb conventions), so a correct GPU engine
 * must produce the oracle's exact conforming mesh. Closes the Phase 1c GPU validation
 * gate that Vitest cannot (no WebGPU in Node).
 *
 * The GPU stores heap ids in the REFERENCE leb convention; the oracle uses World42's
 * terrain_leb convention; the two differ by a geometry-dependent per-level bit swap, so we
 * NEVER compare raw heap-id labels. Instead each side is decoded to GEOMETRY with its
 * own convention's spherical decoder and we compare the centroid sets:
 *   A. GPU leaf centroid set == oracle leaf centroid set (geometric mesh equality).
 *   B. neighbor reciprocity (slot-based, convention-free).
 *   C. zero T-junctions: every reciprocal neighbor shares a FULL edge (>=2 corners).
 *
 * Renders PASS/FAIL to the DOM and publishes `window.__TERRAIN_TOPO_RESULT__`. Reproduce:
 * `npm run serve`, open http://localhost:19000/terrain-topo-test.html.
 */
import { EngineManager } from '../../../../core/render/engine_manager';
import { TerrainTopology } from './terrain_topology';
import { TerrainTopologyKernel, type TerrainGpuState } from './terrain_topology_kernel';
import { terrainCorners, terrainFaceOf, type V3 } from './terrain_eval_leb';
import type { WebGPUEngine } from '@babylonjs/core';

const INVALID = TerrainTopologyKernel.INVALID;

interface CaseResult {
    name: string;
    pass: boolean;
    detail: string;
}

declare global {
    interface Window {
        __TERRAIN_TOPO_RESULT__?: {
            pass: boolean;
            cases: CaseResult[];
            error?: string;
        };
    }
}

interface Scenario {
    name: string;
    capacity: number;
    /** Per-face target LEVEL (depth-3); face f refines uniformly to this level. */
    faceDepths: number[];
    /** Optional per-face target to COARSEN to after refining (exercises the merge half). */
    coarse?: number[];
}

function norm(x: number, y: number, z: number): V3 {
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    return [x * inv, y * inv, z * inv];
}

/** Quantized key of a unit-sphere point (for order-independent set comparison). */
function key(p: V3): string {
    const q = (v: number) => Math.round(v * 1e6);
    return `${q(p[0])},${q(p[1])},${q(p[2])}`;
}

function centroidKey(a: V3, b: V3, c: V3): string {
    return key(norm(a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]));
}

// Convention-invariant face index (top heap bits) — shared with the GPU decoder.
const faceOf = terrainFaceOf;
// `gpuCorners` (the proven reference-convention decoder) now lives in the shared
// terrain_eval_leb module; the GPU's terrain_eval_leb.wgsl is its bit-for-bit twin.
const gpuCorners = terrainCorners;

/** Drive the CPU oracle to its conforming fixpoint under the per-face predicate. */
function runOracle(scenario: Scenario): { centroids: string[]; count: number } {
    const maxLevel = Math.max(...scenario.faceDepths);
    const topo = new TerrainTopology(maxLevel + 4); // cap margin; the predicate stops first
    for (let pass = 0; pass < 100000; pass++) {
        const toSplit: number[] = [];
        for (const leaf of topo.leaves()) {
            const f = faceOf(leaf.heapID, leaf.depth);
            if (leaf.depth - 3 < scenario.faceDepths[f]) toSplit.push(leaf.slot);
        }
        if (toSplit.length === 0) break;
        topo.splitSlots(toSplit);
    }
    if (scenario.coarse) {
        // Coarsen: merge internal nodes whose level >= the face target (their children
        // are then finer than wanted), to the conforming coarse closure.
        const coarse = scenario.coarse;
        topo.coarsenByPredicate((heapID, depth) => depth - 3 >= coarse[faceOf(heapID, depth)]);
    }
    const leaves = topo.leaves();
    const centroids = leaves.map((l) => centroidKey(l.a as V3, l.l as V3, l.r as V3)).sort();
    return { centroids, count: leaves.length };
}

interface GpuRun {
    state: TerrainGpuState;
    /** EvaluateLEB output: capacity * 9 f32 (c0.xyz, c1.xyz, c2.xyz per slot). */
    positions: Float32Array;
    frames: number;
    grewAtCap: boolean;
}

/** Run split or merge frames until the live count is stable for 2 frames (fixpoint). */
async function fixpoint(
    kernel: TerrainTopologyKernel,
    merge: boolean,
    maxFrames: number
): Promise<{ state: TerrainGpuState; frames: number; converged: boolean }> {
    let prevCount = (await kernel.readState()).count;
    let stable = 0;
    let frames = 0;
    let state = await kernel.readState();
    for (let f = 0; f < maxFrames; f++) {
        if (merge) kernel.runMergeFrame();
        else kernel.runFrame();
        state = await kernel.readState();
        frames = f + 1;
        if (state.count === prevCount) {
            stable++;
            if (stable >= 2) return { state, frames, converged: true };
        } else {
            stable = 0;
        }
        prevCount = state.count;
    }
    return { state, frames, converged: false };
}

/** Drive the GPU kernel: refine to faceDepths, then (optionally) coarsen to `coarse`. */
async function runGpu(engine: WebGPUEngine, scenario: Scenario, useIndirect: boolean): Promise<GpuRun> {
    const kernel = new TerrainTopologyKernel(engine, scenario.capacity, 'predicate', useIndirect);
    try {
        await kernel.whenReady();
        kernel.uploadSeed(); // self-primes the sum-tree (runReduce) for frame 0
        kernel.setFaceDepths(scenario.faceDepths);

        const maxLevel = Math.max(...scenario.faceDepths, ...(scenario.coarse ?? []));
        const cap = 6 * maxLevel + 40;
        const split = await fixpoint(kernel, false, cap);
        let frames = split.frames;
        let converged = split.converged;
        let state = split.state;
        if (scenario.coarse) {
            kernel.setFaceDepths(scenario.coarse);
            const merged = await fixpoint(kernel, true, cap);
            frames += merged.frames;
            converged = converged && merged.converged;
            state = merged.state;
        }
        // Decode the converged topology to corners on the GPU (the render path's
        // EvaluateLEB) so the WGSL decoder can be cross-checked against the TS.
        kernel.runEvalLeb();
        const positions = await kernel.readPositions();
        return { state, positions, frames, grewAtCap: !converged };
    } finally {
        kernel.dispose();
    }
}

/** GPU live leaf centroids (reference-convention decode), sorted. */
function gpuCentroids(gpu: TerrainGpuState): string[] {
    const out: string[] = [];
    for (let s = 0; s < gpu.heapID.length; s++) {
        const h = gpu.heapID[s];
        if (h === 0) continue;
        const [a, b, c] = gpuCorners(h);
        out.push(centroidKey(a, b, c));
    }
    return out.sort();
}

/** A. GPU centroid set == oracle centroid set (geometric mesh equality). */
function checkGeometry(gpu: string[], oracle: string[]): string | null {
    if (gpu.length !== oracle.length) {
        return `leaf count GPU=${gpu.length} oracle=${oracle.length}`;
    }
    for (let i = 0; i < gpu.length; i++) {
        if (gpu[i] !== oracle[i]) return `centroid[#${i}] GPU=${gpu[i]} oracle=${oracle[i]}`;
    }
    return null;
}

/** B. Every non-INVALID GPU neighbor reciprocates (symmetry). */
function checkReciprocity(gpu: TerrainGpuState): string | null {
    const nb = gpu.neighbors;
    for (let s = 0; s < gpu.heapID.length; s++) {
        if (gpu.heapID[s] === 0) continue;
        for (let k = 0; k < 3; k++) {
            const m = nb[s * 3 + k];
            // Closed octahedron: a live leaf must have 3 real neighbors.
            if (m === INVALID) return `slot ${s} edge ${k} is INVALID (closed manifold)`;
            if (m >= gpu.heapID.length || gpu.heapID[m] === 0) {
                return `slot ${s} edge ${k} -> dead/oob ${m}`;
            }
            let back = false;
            for (let j = 0; j < 3; j++) if (nb[m * 3 + j] === s) back = true;
            if (!back) return `slot ${s} edge ${k} -> ${m}, not reciprocal`;
        }
    }
    return null;
}

/** C. Zero T-junctions: each reciprocal neighbor pair shares a FULL edge (>=2 corners). */
function checkWatertight(gpu: TerrainGpuState): string | null {
    const tol = 1e-6;
    const N = gpu.heapID.length;
    const corners: (V3[] | null)[] = new Array(N).fill(null);
    for (let s = 0; s < N; s++) {
        if (gpu.heapID[s] === 0) continue;
        corners[s] = gpuCorners(gpu.heapID[s]);
    }
    const sharedCount = (cs: V3[], cm: V3[]): number => {
        let n = 0;
        for (const p of cs) {
            for (const q of cm) {
                if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol) {
                    n++;
                    break;
                }
            }
        }
        return n;
    };
    const nb = gpu.neighbors;
    for (let s = 0; s < N; s++) {
        const cs = corners[s];
        if (!cs) continue;
        for (let k = 0; k < 3; k++) {
            const m = nb[s * 3 + k];
            if (m === INVALID) return `slot ${s} edge ${k} INVALID`;
            const cm = corners[m];
            if (!cm) return `slot ${s} edge ${k} -> dead ${m}`;
            if (sharedCount(cs, cm) < 2) {
                return `T-junction: slot ${s} (h=${gpu.heapID[s]}) & ${m} (h=${gpu.heapID[m]}) share <2 corners`;
            }
        }
    }
    return null;
}

/**
 * D. The GPU EvaluateLEB decoder (terrain_eval_leb.wgsl) matches the proven TS decoder
 * (terrainCorners) for every live slot — proves the render-path decoder bit-for-bit.
 */
function checkEvalLeb(gpu: TerrainGpuState, positions: Float32Array): string | null {
    const tol = 1e-5; // f32 GPU vs f64 TS spherical decode
    for (let s = 0; s < gpu.heapID.length; s++) {
        const h = gpu.heapID[s];
        if (h === 0) continue;
        const tri = terrainCorners(h);
        const b = s * 9;
        for (let c = 0; c < 3; c++) {
            for (let k = 0; k < 3; k++) {
                const got = positions[b + c * 3 + k];
                const want = tri[c][k];
                if (Math.abs(got - want) > tol) {
                    return `slot ${s} (h=${h}) corner ${c}.${k}: GPU=${got.toFixed(6)} TS=${want.toFixed(6)}`;
                }
            }
        }
    }
    return null;
}

async function runScenario(engine: WebGPUEngine, scenario: Scenario, useIndirect: boolean): Promise<CaseResult> {
    const oracle = runOracle(scenario);
    const run = await runGpu(engine, scenario, useIndirect);
    const gpu = run.state;
    const gpuC = gpuCentroids(gpu);
    const tag = useIndirect ? ' [indirect]' : ' [direct]';
    const name = scenario.name + tag;

    const a = checkGeometry(gpuC, oracle.centroids);
    const b = checkReciprocity(gpu);
    const c = checkWatertight(gpu);
    const d = checkEvalLeb(gpu, run.positions);
    if (!a && !b && !c && !d) {
        return { name, pass: true, detail: `leaves=${oracle.count} frames=${run.frames} A+B+C+D OK` };
    }
    const parts: string[] = [`frames=${run.frames}${run.grewAtCap ? ' GREW@CAP' : ''}`, `gpu=${gpuC.length} oracle=${oracle.count}`];
    if (a) parts.push(`A:${a}`);
    if (b) parts.push(`B:${b}`);
    if (c) parts.push(`C:${c}`);
    if (d) parts.push(`D:${d}`);
    return { name, pass: false, detail: parts.join(' | ') };
}

function scenarios(): Scenario[] {
    return [
        { name: 'uniform L1 all faces', capacity: 4096, faceDepths: [1, 1, 1, 1, 1, 1, 1, 1] },
        { name: 'uniform L2 all faces', capacity: 4096, faceDepths: [2, 2, 2, 2, 2, 2, 2, 2] },
        { name: 'one face deep (face0 L6)', capacity: 4096, faceDepths: [6, 0, 0, 0, 0, 0, 0, 0] },
        { name: 'seam step (0:L6 4:L1)', capacity: 4096, faceDepths: [6, 1, 1, 1, 1, 1, 1, 1] },
        { name: 'checker depths', capacity: 8192, faceDepths: [5, 1, 5, 1, 2, 4, 2, 4] },
        { name: 'deep face1 L9', capacity: 16384, faceDepths: [1, 9, 1, 1, 1, 1, 1, 1] },
        // --- merge (simplification) half: refine, then coarsen ---
        {
            name: 'MERGE uniform L4 -> L2',
            capacity: 4096,
            faceDepths: [4, 4, 4, 4, 4, 4, 4, 4],
            coarse: [2, 2, 2, 2, 2, 2, 2, 2]
        },
        {
            name: 'MERGE round-trip L3 -> seed',
            capacity: 4096,
            faceDepths: [3, 3, 3, 3, 3, 3, 3, 3],
            coarse: [0, 0, 0, 0, 0, 0, 0, 0]
        },
        {
            name: 'MERGE face0 L6 -> L0',
            capacity: 4096,
            faceDepths: [6, 0, 0, 0, 0, 0, 0, 0],
            coarse: [0, 0, 0, 0, 0, 0, 0, 0]
        },
        {
            name: 'MERGE checker -> flat L1',
            capacity: 8192,
            faceDepths: [5, 1, 5, 1, 2, 4, 2, 4],
            coarse: [1, 1, 1, 1, 1, 1, 1, 1]
        }
    ];
}

function render(out: HTMLElement, cases: CaseResult[], pass: boolean, error?: string): void {
    const head = error
        ? `ERROR: ${error}`
        : `${pass ? 'PASS' : 'FAIL'} — ${cases.filter((c) => c.pass).length}/${cases.length} cases`;
    const lines = cases.map((c) => `${c.pass ? '  ok' : 'FAIL'}  ${c.name} — ${c.detail}`);
    out.textContent = [head, '', ...lines].join('\n');
}

async function main(): Promise<void> {
    const out = document.getElementById('out') as HTMLElement;
    const canvas = document.getElementById('c') as HTMLCanvasElement;
    const cases: CaseResult[] = [];

    let engine: WebGPUEngine;
    try {
        engine = await EngineManager.Create(canvas);
    } catch (e) {
        const error = `WebGPU unavailable: ${String(e)}`;
        window.__TERRAIN_TOPO_RESULT__ = { pass: false, cases, error };
        render(out, cases, false, error);
        return;
    }

    try {
        // Run every scenario on BOTH the direct and the indirect-dispatch path so the
        // indirect conversion is proven to produce the oracle's exact conforming mesh.
        for (const useIndirect of [false, true]) {
            for (const scenario of scenarios()) {
                cases.push(await runScenario(engine, scenario, useIndirect));
                render(out, cases, cases.every((c) => c.pass));
            }
        }
        const pass = cases.every((c) => c.pass);
        window.__TERRAIN_TOPO_RESULT__ = { pass, cases };
        render(out, cases, pass);
    } catch (e) {
        const error = String((e as Error)?.stack ?? e);
        window.__TERRAIN_TOPO_RESULT__ = { pass: false, cases, error };
        render(out, cases, false, error);
    } finally {
        engine.dispose();
    }
}

void main();
