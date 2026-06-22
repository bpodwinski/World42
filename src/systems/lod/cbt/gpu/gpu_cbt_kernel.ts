/**
 * GPU CBT kernel (Dupuy 2021) — owns the per-planet storage buffer and the
 * compute passes that maintain the concurrent binary tree on the GPU. Phase 1
 * scope: the heap StorageBuffer + the sum-reduction pass + upload/readback. LEB
 * decode, the split/merge update pass and the implicit-mesh render are layered on
 * in later phases.
 *
 * WebGPU only. The heap is bound as `array<atomic<u32>>` (read_write) by the
 * compute shaders and re-bound as `array<u32>` (read) by the render shader; the
 * underlying bytes are the same buffer.
 */
import {
    ComputeShader,
    Constants,
    StorageBuffer,
    UniformBuffer,
    type WebGPUEngine,
} from '@babylonjs/core';
import cbtHeapRwWgsl from '../../../../assets/shaders/cbt/gpu/cbt_heap_rw.wgsl';
import cbtLebWgsl from '../../../../assets/shaders/cbt/gpu/cbt_leb.wgsl';
import cbtSumReductionWgsl from '../../../../assets/shaders/cbt/gpu/cbt_sum_reduction.compute.wgsl';
import cbtDecodeDumpWgsl from '../../../../assets/shaders/cbt/gpu/cbt_decode_dump.compute.wgsl';
import { cbtHeapByteSize } from './gpu_cbt_buffers';

const WORKGROUP_SIZE = 256;

/** Compose a compute source: depth constant + given includes + entry point. */
function composeCompute(maxDepth: number, ...parts: string[]): string {
    return `const CBT_MAX_DEPTH : u32 = ${maxDepth}u;\n` + parts.join('\n');
}

export class GpuCbtKernel {
    readonly maxDepth: number;
    readonly heapBuffer: StorageBuffer;

    private readonly engine: WebGPUEngine;
    private readonly key: string;
    private readonly reduction: ComputeShader;
    /** One uniform buffer per reduced level, each holding its constant passDepth. */
    private readonly levelParams: UniformBuffer[] = [];
    /** Lazily-built decode-dump shader (validation only). */
    private dumpShader: ComputeShader | null = null;

    constructor(engine: WebGPUEngine, key: string, maxDepth: number) {
        this.engine = engine;
        this.key = key;
        this.maxDepth = maxDepth;

        this.heapBuffer = new StorageBuffer(
            engine,
            cbtHeapByteSize(maxDepth),
            // STORAGE: compute read/write. WRITE: CPU seed (CopyDst). READ: readback
            // (CopySrc). INDIRECT: heap root can source indirect dispatch (Phase 3).
            Constants.BUFFER_CREATIONFLAG_STORAGE |
                Constants.BUFFER_CREATIONFLAG_WRITE |
                Constants.BUFFER_CREATIONFLAG_READ |
                Constants.BUFFER_CREATIONFLAG_INDIRECT,
            `cbt_heap_${key}`
        );

        this.reduction = new ComputeShader(
            `cbt_reduce_${key}`,
            engine,
            { computeSource: composeCompute(maxDepth, cbtHeapRwWgsl, cbtSumReductionWgsl) },
            {
                bindingsMapping: {
                    cbt_heap: { group: 0, binding: 0 },
                    reduceParams: { group: 0, binding: 1 },
                },
            }
        );
        this.reduction.onError = (_effect, errors) => {
            // eslint-disable-next-line no-console
            console.error(`[GpuCbtKernel] reduction compile error:\n${errors}`);
        };
        this.reduction.setStorageBuffer('cbt_heap', this.heapBuffer);

        // Pre-build a uniform buffer per level (depth D-1 .. 0). Updating a single
        // UBO between same-frame dispatches would make every dispatch see only the
        // last value (writeBuffer coalesces before submit), so each level needs its
        // own buffer.
        for (let depth = 0; depth < maxDepth; depth++) {
            const ubo = new UniformBuffer(engine, undefined, undefined, `cbt_reduce_lvl_${depth}`);
            ubo.addUniform('data', 4); // vec4<u32>; depth is small & non-negative
            ubo.updateInt4('data', depth, 0, 0, 0);
            ubo.update();
            this.levelParams[depth] = ubo;
        }
    }

    /** Resolve once the compute shaders have finished compiling (dispatch no-ops before). */
    async whenReady(timeoutMs = 8000): Promise<void> {
        const end = performance.now() + timeoutMs;
        while (!this.reduction.isReady()) {
            if (performance.now() > end) {
                throw new Error('GpuCbtKernel compute shaders not ready (timeout)');
            }
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    /** Replace the whole heap (bit-packed) — used to seed the initial tree. */
    uploadHeap(data: Uint32Array): void {
        this.heapBuffer.update(data);
    }

    /**
     * Run the full sum-reduction: levels D-1 .. 0, in order (each depends on the
     * level below). WebGPU synchronizes the read-after-write between dispatches.
     */
    runReduction(): void {
        for (let depth = this.maxDepth - 1; depth >= 0; depth--) {
            const count = Math.pow(2, depth);
            const groups = Math.max(1, Math.ceil(count / WORKGROUP_SIZE));
            this.reduction.setUniformBuffer('reduceParams', this.levelParams[depth]);
            this.reduction.dispatch(groups, 1, 1);
        }
    }

    /**
     * Decode every leaf's 3 unit corners on the GPU and read them back (9 floats
     * per leaf), for validating the LEB decode against the CPU reference. `leafCount`
     * must be the current tree's leaf count (the caller knows it in tests).
     */
    async dumpLeafCorners(leafCount: number): Promise<Float32Array> {
        if (!this.dumpShader) {
            this.dumpShader = new ComputeShader(
                `cbt_dump_${this.key}`,
                this.engine,
                {
                    computeSource: composeCompute(
                        this.maxDepth,
                        cbtHeapRwWgsl,
                        cbtLebWgsl,
                        cbtDecodeDumpWgsl
                    ),
                },
                {
                    bindingsMapping: {
                        cbt_heap: { group: 0, binding: 0 },
                        outCorners: { group: 0, binding: 1 },
                        dumpParams: { group: 0, binding: 2 },
                    },
                }
            );
            this.dumpShader.onError = (_e, errors) => {
                // eslint-disable-next-line no-console
                console.error(`[GpuCbtKernel] dump compile error:\n${errors}`);
            };
            this.dumpShader.setStorageBuffer('cbt_heap', this.heapBuffer);
        }

        const out = new StorageBuffer(
            this.engine,
            Math.max(1, leafCount) * 9 * 4,
            Constants.BUFFER_CREATIONFLAG_STORAGE |
                Constants.BUFFER_CREATIONFLAG_WRITE |
                Constants.BUFFER_CREATIONFLAG_READ,
            `cbt_dump_out_${this.key}`
        );
        const params = new UniformBuffer(this.engine, undefined, undefined, `cbt_dump_params_${this.key}`);
        params.addUniform('data', 4);
        params.updateInt4('data', leafCount, 0, 0, 0);
        params.update();

        this.dumpShader.setStorageBuffer('outCorners', out);
        this.dumpShader.setUniformBuffer('dumpParams', params);

        const ready = performance.now() + 8000;
        while (!this.dumpShader.isReady()) {
            if (performance.now() > ready) throw new Error('dump shader not ready (timeout)');
            await new Promise((r) => setTimeout(r, 10));
        }

        this.engine.beginFrame();
        this.dumpShader.dispatch(Math.max(1, Math.ceil(leafCount / WORKGROUP_SIZE)), 1, 1);
        this.engine.endFrame();

        const bytes = (await out.read(undefined, undefined, undefined, true)) as Uint8Array;
        const result = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + leafCount * 9 * 4));
        out.dispose();
        params.dispose();
        return result;
    }

    /** Read the whole heap back to the CPU (async; for tests / telemetry only). */
    async readHeap(): Promise<Uint32Array> {
        // noDelay=true flushes immediately so this resolves without a render loop.
        const bytes = (await this.heapBuffer.read(
            undefined,
            undefined,
            undefined,
            true
        )) as Uint8Array;
        return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    }

    dispose(): void {
        for (const ubo of this.levelParams) ubo.dispose();
        this.levelParams.length = 0;
        this.heapBuffer.dispose();
    }
}
