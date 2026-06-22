/**
 * GPU validation (run via `?cbtgputest=1`).
 *  Phase 1: seed a CBT bitfield, upload, GPU sum-reduce, read back, assert
 *           byte-identical to the CPU reference reduction (proves WGSL bit-packing,
 *           atomic reduction, storage upload/readback, decode).
 *  Phase 2: build a tree with varied depths, GPU-decode every leaf's corners via
 *           LEB, and assert they match the CPU LEB reference within f32 tolerance
 *           (proves the octahedron mapping + bisection decode port).
 * Logs `[cbt-gpu-selftest] PASS|FAIL ...` for headless capture.
 */
import type { WebGPUEngine } from '@babylonjs/core';
import { CbtCpuHeap } from './gpu_cbt_buffers';
import { GpuCbtKernel } from './gpu_cbt_kernel';
import { lebDecodeUnit } from './gpu_cbt_octahedron';

const TAG = '[cbt-gpu-selftest]';

function fail(msg: string): boolean {
    // eslint-disable-next-line no-console
    console.error(`${TAG} FAIL ${msg}`);
    return false;
}

/** Phase 1: GPU sum-reduction is byte-identical to the CPU reference. */
async function checkReduction(engine: WebGPUEngine): Promise<boolean> {
    const D = 10;
    const expected = new CbtCpuHeap(D);
    expected.seedLevel(3);
    expected.sumReduce();

    const seed = new CbtCpuHeap(D);
    seed.seedLevel(3);

    const kernel = new GpuCbtKernel(engine, 'st_reduce', D);
    try {
        await kernel.whenReady();
        kernel.uploadHeap(seed.heap);
        engine.beginFrame();
        kernel.runReduction();
        engine.endFrame();
        const gpu = await kernel.readHeap();

        let firstBad = -1;
        let mismatches = 0;
        for (let i = 0; i < expected.heap.length; i++) {
            if (gpu[i] !== expected.heap[i]) {
                if (firstBad < 0) firstBad = i;
                mismatches++;
            }
        }
        if (mismatches > 0) {
            return fail(
                `reduction mismatch: ${mismatches} words (first @${firstBad}: ` +
                    `gpu=${gpu[firstBad]} expected=${expected.heap[firstBad]})`
            );
        }
        const gpuHeap = new CbtCpuHeap(D, gpu);
        if (gpuHeap.nodeCount() !== 8) return fail(`nodeCount ${gpuHeap.nodeCount()} != 8`);
        // eslint-disable-next-line no-console
        console.log(`${TAG} reduction OK (D=${D}, ${expected.heap.length} words)`);
        return true;
    } finally {
        kernel.dispose();
    }
}

/** Phase 2: GPU LEB decode matches the CPU reference within f32 tolerance. */
async function checkDecode(engine: WebGPUEngine): Promise<boolean> {
    const D = 12;
    const heap = new CbtCpuHeap(D);
    heap.seedLevel(3);
    // Split a few leaves (set the right child's leaf bit) to create depths 4 and 5.
    heap.setBit(heap.bfIndex(17, 4), 1); // split face 8 (depth 3 -> 16,17)
    heap.setBit(heap.bfIndex(19, 4), 1); // split face 9 (depth 3 -> 18,19)
    heap.setBit(heap.bfIndex(33, 5), 1); // split node 16 (depth 4 -> 32,33)

    // Seed-only copy (bitfield, no sums) to upload; reduced copy for CPU decode.
    const seedOnly = new CbtCpuHeap(D, heap.heap.slice());
    heap.sumReduce();
    const count = heap.nodeCount();

    const kernel = new GpuCbtKernel(engine, 'st_decode', D);
    try {
        await kernel.whenReady();
        kernel.uploadHeap(seedOnly.heap);
        engine.beginFrame();
        kernel.runReduction();
        engine.endFrame();

        const gpu = await kernel.dumpLeafCorners(count);

        const TOL = 1e-4;
        let worst = 0;
        for (let h = 0; h < count; h++) {
            const node = heap.decode(h);
            const ref = lebDecodeUnit(node.id, node.depth);
            const flat = [...ref.a, ...ref.l, ...ref.r];
            for (let k = 0; k < 9; k++) {
                const d = Math.abs(gpu[h * 9 + k] - flat[k]);
                worst = Math.max(worst, d);
                if (d > TOL) {
                    return fail(
                        `decode mismatch leaf ${h} (id=${node.id} depth=${node.depth}) ` +
                            `comp ${k}: gpu=${gpu[h * 9 + k]} ref=${flat[k]} (|d|=${d})`
                    );
                }
            }
        }
        // eslint-disable-next-line no-console
        console.log(`${TAG} decode OK (D=${D}, leaves=${count}, worst|d|=${worst.toExponential(2)})`);
        return true;
    } finally {
        kernel.dispose();
    }
}

export async function runGpuCbtSelfTest(engine: WebGPUEngine): Promise<boolean> {
    if (!engine.isWebGPU) {
        // eslint-disable-next-line no-console
        console.warn(`${TAG} SKIP (engine is not WebGPU)`);
        return false;
    }
    try {
        const r1 = await checkReduction(engine);
        const r2 = await checkDecode(engine);
        if (r1 && r2) {
            // eslint-disable-next-line no-console
            console.log(`${TAG} PASS (all checks)`);
            return true;
        }
        return false;
    } catch (e) {
        return fail(`exception: ${(e as Error).message}`);
    }
}
