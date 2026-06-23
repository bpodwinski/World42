/**
 * Dev-only WebGPU test page entry: cross-checks the OCBT GPU pool allocator
 * (`ocbt_pool.wgsl`, driven by `OcbtPoolGpuHarness`) against the CPU oracle
 * (`OcbtPool`). For each capacity x allocation pattern it asserts the GPU sum-tree,
 * the allocated count, and the GPU `decode_bit` / `decode_bit_complement` outputs all
 * match the mirror bit-for-bit — closing the Phase 0 verification gate that Vitest
 * cannot (no WebGPU in Node).
 *
 * Renders a PASS/FAIL report to the DOM and publishes `window.__OCBT_GPU_RESULT__`
 * (shape: `{ pass, cases:[{name,pass,detail}], error? }`). Isolated from the planet
 * scene: its own minimal WebGPU engine, no LOD, no catalog.
 *
 * Reproduce: `npm run serve`, open http://localhost:19000/ocbt-test.html — the page
 * shows `PASS — N/N cases`. The page is a dev-only build entry (see rspack.config.js)
 * and is excluded from production builds. For automation, navigate a WebGPU-enabled
 * browser to that URL and read `window.__OCBT_GPU_RESULT__.pass`.
 */
import { EngineManager } from '../../../../core/render/engine_manager';
import { OcbtPool } from './ocbt_cpu_mirror';
import { OcbtPoolGpuHarness } from './ocbt_pool_gpu_harness';
import type { WebGPUEngine } from '@babylonjs/core';

interface CaseResult {
    name: string;
    pass: boolean;
    detail: string;
}

declare global {
    interface Window {
        __OCBT_GPU_RESULT__?: {
            pass: boolean;
            cases: CaseResult[];
            error?: string;
        };
    }
}

/** Seeded LCG -> pseudo-random allocated subset (~fraction of slots). */
function randomSubset(capacity: number, fraction: number, seed: number): number[] {
    let s = seed >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
    const out: number[] = [];
    for (let slot = 0; slot < capacity; slot++) {
        if (rnd() < fraction) out.push(slot);
    }
    return out;
}

/** Build the named allocation patterns for a capacity. */
function patterns(capacity: number): { name: string; slots: number[] }[] {
    const all = Array.from({ length: capacity }, (_, i) => i);
    const sparse = [1, 2, 5].filter((s) => s < capacity);
    const contiguous = all.slice(0, Math.min(capacity, Math.max(1, capacity >> 2)));
    return [
        { name: 'empty', slots: [] },
        { name: 'full', slots: all },
        { name: 'sparse{1,2,5}', slots: sparse },
        { name: 'contiguous-lowest-quarter', slots: contiguous },
        { name: 'random~37%', slots: randomSubset(capacity, 0.37, 0x1234 ^ capacity) }
    ];
}

/** Compare GPU output against the CPU oracle for one allocation pattern. */
function checkCase(
    capacity: number,
    name: string,
    slots: number[],
    gpu: { tree: Uint32Array; decodeOut: Uint32Array; count: number }
): CaseResult {
    const label = `cap=${capacity} ${name}`;
    const pool = new OcbtPool(capacity);
    for (const s of slots) pool.setBit(s, true);
    const tree = pool.treeSnapshot();
    const count = pool.count();

    if (gpu.count !== count) {
        return { name: label, pass: false, detail: `count GPU=${gpu.count} CPU=${count}` };
    }
    // Sum-tree equality (skip index 0, unused). If trees match, every decode matches
    // by construction; the explicit decode check below additionally validates the WGSL
    // decode code path on real hardware.
    for (let i = 1; i < 2 * capacity; i++) {
        if (gpu.tree[i] !== tree[i]) {
            return {
                name: label,
                pass: false,
                detail: `tree[${i}] GPU=${gpu.tree[i]} CPU=${tree[i]}`
            };
        }
    }
    // decode_bit: i-th allocated slot.
    for (let i = 0; i < count; i++) {
        const want = pool.decodeBit(i);
        if (gpu.decodeOut[i] !== want) {
            return {
                name: label,
                pass: false,
                detail: `decodeBit(${i}) GPU=${gpu.decodeOut[i]} CPU=${want}`
            };
        }
    }
    // decode_bit_complement: i-th free slot (output offset by count).
    const free = capacity - count;
    for (let i = 0; i < free; i++) {
        const want = pool.decodeBitComplement(i);
        if (gpu.decodeOut[count + i] !== want) {
            return {
                name: label,
                pass: false,
                detail: `decodeBitComplement(${i}) GPU=${gpu.decodeOut[count + i]} CPU=${want}`
            };
        }
    }
    return {
        name: label,
        pass: true,
        detail: `count=${count} free=${free} tree+decode OK`
    };
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
        engine = await EngineManager.CreateWebGPU(canvas);
    } catch (e) {
        const error = `WebGPU unavailable: ${String(e)}`;
        window.__OCBT_GPU_RESULT__ = { pass: false, cases, error };
        render(out, cases, false, error);
        return;
    }

    try {
        // 8 = golden; 1024/16384 exercise multi-level reduce + larger readback.
        for (const capacity of [8, 1024, 16384]) {
            const harness = new OcbtPoolGpuHarness(engine, capacity);
            await harness.whenReady();
            for (const { name, slots } of patterns(capacity)) {
                const gpu = await harness.run(slots);
                cases.push(checkCase(capacity, name, slots, gpu));
            }
            harness.dispose();
        }
        const pass = cases.every((c) => c.pass);
        window.__OCBT_GPU_RESULT__ = { pass, cases };
        render(out, cases, pass);
    } catch (e) {
        const error = String((e as Error)?.stack ?? e);
        window.__OCBT_GPU_RESULT__ = { pass: false, cases, error };
        render(out, cases, false, error);
    } finally {
        engine.dispose();
    }
}

void main();
