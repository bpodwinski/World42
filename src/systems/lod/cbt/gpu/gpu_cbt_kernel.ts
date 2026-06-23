/**
 * GPU CBT kernel (Dupuy 2021) — owns the per-planet storage buffer and the compute
 * passes that maintain the concurrent binary tree entirely on the GPU: the
 * bit-packed heap StorageBuffer, the adaptive update pass (metric-driven
 * forced-diamond split/merge, watertight) and the sum-reduction. Plus the initial
 * CPU seed upload and a cheap live leaf-count readback for HUD telemetry.
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
import cbtHeapRoWgsl from '../../../../assets/shaders/cbt/gpu/cbt_heap_ro.wgsl';
import cbtLebWgsl from '../../../../assets/shaders/cbt/gpu/cbt_leb.wgsl';
import cbtConformWgsl from '../../../../assets/shaders/cbt/gpu/cbt_conform.wgsl';
import cbtSumReductionWgsl from '../../../../assets/shaders/cbt/gpu/cbt_sum_reduction.compute.wgsl';
import cbtUpdateWgsl from '../../../../assets/shaders/cbt/gpu/cbt_update.compute.wgsl';
import cbtDispatchArgsWgsl from '../../../../assets/shaders/cbt/gpu/cbt_dispatch_args.compute.wgsl';
import { cbtHeapByteSize } from './gpu_cbt_buffers';

const WORKGROUP_SIZE = 256;

/** Per-frame inputs to the GPU adaptive update pass. */
export type CbtUpdateFrameParams = {
    /** Camera position in the planet's local (unit-sphere) space. */
    camLocal: [number, number, number];
    radius: number;
    /** viewportHeight / (2·tan(fov/2)), computed on the main thread. */
    focal: number;
    splitThreshold: number;
    mergeThreshold: number;
    /** 0 = split pass, 1 = merge pass (alternate per frame to avoid races). */
    parity: number;
    /** Backside-cull split candidates on the far hemisphere (default false). */
    cullBackface?: boolean;
    /** Horizon guard-band cosine for the backside cull (default -0.05). */
    cullMinDot?: number;
};

/** Compose a compute source: depth constant + given includes + entry point. */
function composeCompute(maxDepth: number, ...parts: string[]): string {
    return `const CBT_MAX_DEPTH : u32 = ${maxDepth}u;\n` + parts.join('\n');
}

export class GpuCbtKernel {
    readonly maxDepth: number;
    /** Max possible leaves (2^maxDepth) — the dispatch/instance upper bound. */
    readonly maxLeaves: number;
    readonly heapBuffer: StorageBuffer;

    private readonly engine: WebGPUEngine;
    private readonly key: string;
    private readonly reduction: ComputeShader;
    private readonly updateShader: ComputeShader;
    /** One-thread pass: live leaf count (heap root) -> indirect workgroup args. */
    private readonly dispatcher: ComputeShader;
    /** Indirect args for the update dispatch: [workgroupCountX, 1, 1, pad]. */
    private readonly dispatchArgs: StorageBuffer;
    private readonly updateParams: UniformBuffer;
    /** One uniform buffer per reduced level, each holding its constant passDepth. */
    private readonly levelParams: UniformBuffer[] = [];

    constructor(engine: WebGPUEngine, key: string, maxDepth: number) {
        this.engine = engine;
        this.key = key;
        this.maxDepth = maxDepth;
        this.maxLeaves = Math.pow(2, maxDepth);

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

        // Adaptive update pass (metric-driven split/merge).
        this.updateShader = new ComputeShader(
            `cbt_update_${key}`,
            engine,
            {
                computeSource: composeCompute(
                    maxDepth,
                    cbtHeapRwWgsl,
                    cbtLebWgsl,
                    cbtConformWgsl,
                    cbtUpdateWgsl
                ),
            },
            {
                bindingsMapping: {
                    cbt_heap: { group: 0, binding: 0 },
                    up: { group: 0, binding: 1 },
                },
            }
        );
        this.updateShader.onError = (_e, errors) => {
            // eslint-disable-next-line no-console
            console.error(`[GpuCbtKernel] update compile error:\n${errors}`);
        };
        this.updateShader.setStorageBuffer('cbt_heap', this.heapBuffer);
        this.updateParams = new UniformBuffer(engine, undefined, undefined, `cbt_update_params_${key}`);
        this.updateParams.addUniform('camLocalRadius', 4);
        this.updateParams.addUniform('thresholds', 4);
        this.updateParams.addUniform('ints', 4);
        this.updateShader.setUniformBuffer('up', this.updateParams);

        // Indirect-args buffer (16 bytes = 4 u32; dispatchIndirect reads [0..2] =
        // workgroupCount X/Y/Z, [3] is padding). STORAGE so the dispatcher can write
        // it, INDIRECT so the update can source its dispatch from it, WRITE (CopyDst)
        // so the CPU can seed it via initDispatchArgs().
        this.dispatchArgs = new StorageBuffer(
            engine,
            16,
            Constants.BUFFER_CREATIONFLAG_STORAGE |
                Constants.BUFFER_CREATIONFLAG_INDIRECT |
                Constants.BUFFER_CREATIONFLAG_WRITE,
            `cbt_dispatch_args_${key}`
        );

        // One-thread "dispatcher": reads the live leaf count (heap root, read-only)
        // and writes ceil(count/256) into the indirect args. A ComputeShader needs
        // explicit @group/@binding in the WGSL (unlike a ShaderMaterial), and
        // cbt_heap_ro.wgsl expects the includer to declare the heap var — so the
        // read-only heap decl is passed as a compose part.
        this.dispatcher = new ComputeShader(
            `cbt_dispatch_${key}`,
            engine,
            {
                computeSource: composeCompute(
                    maxDepth,
                    '@group(0) @binding(0) var<storage, read> cbt_heap : array<u32>;',
                    cbtHeapRoWgsl,
                    cbtDispatchArgsWgsl
                ),
            },
            {
                bindingsMapping: {
                    cbt_heap: { group: 0, binding: 0 },
                    cbtDispatchArgs: { group: 0, binding: 1 },
                },
            }
        );
        this.dispatcher.onError = (_e, errors) => {
            // eslint-disable-next-line no-console
            console.error(`[GpuCbtKernel] dispatcher compile error:\n${errors}`);
        };
        this.dispatcher.setStorageBuffer('cbt_heap', this.heapBuffer);
        this.dispatcher.setStorageBuffer('cbtDispatchArgs', this.dispatchArgs);

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
        while (!this.reduction.isReady() || !this.updateShader.isReady() || !this.dispatcher.isReady()) {
            if (performance.now() > end) {
                throw new Error('GpuCbtKernel compute shaders not ready (timeout)');
            }
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    /**
     * Build the update pass's indirect dispatch args from the live leaf count.
     * Must run before {@link runUpdate} each frame; reads the heap root left by the
     * previous frame's reduction (or the CPU seed on frame 0).
     */
    runDispatchArgs(): void {
        this.dispatcher.dispatch(1, 1, 1);
    }

    /**
     * CPU-seed the indirect args from a known live-leaf count (call once after the
     * initial {@link uploadHeap}), so frame 0 dispatches a correct, non-zero group
     * count even before the dispatcher compute pipeline is ready.
     */
    initDispatchArgs(liveLeafCount: number): void {
        const groups = Math.max(1, Math.ceil(liveLeafCount / WORKGROUP_SIZE));
        this.dispatchArgs.update(new Uint32Array([groups, 1, 1, 0]));
    }

    /**
     * One adaptive update pass (split or merge by parity). Dispatched INDIRECTLY:
     * the workgroup count comes from {@link runDispatchArgs} (= ceil(liveLeaves/256)),
     * so cost scales with the live leaf count, not 2^maxDepth.
     */
    runUpdate(p: CbtUpdateFrameParams): void {
        const cullMinDot = p.cullMinDot ?? -0.05;
        const cullBackface = p.cullBackface ? 1 : 0;
        this.updateParams.updateFloat4('camLocalRadius', p.camLocal[0], p.camLocal[1], p.camLocal[2], p.radius);
        this.updateParams.updateFloat4('thresholds', p.focal, p.splitThreshold, p.mergeThreshold, cullMinDot);
        this.updateParams.updateInt4('ints', this.maxDepth, p.parity, cullBackface, 0);
        this.updateParams.update();
        this.updateShader.dispatchIndirect(this.dispatchArgs);
    }

    /** Replace the whole heap (bit-packed) — used to seed the initial tree. */
    uploadHeap(data: Uint32Array): void {
        this.heapBuffer.update(data);
    }

    /**
     * Run the full sum-reduction: levels D-1 .. 0, in order (each depends on the
     * level below). WebGPU synchronizes the read-after-write between dispatches.
     *
     * NOT made indirect: level d touches exactly 2^d internal nodes (a property of
     * the perfect tree, independent of the live leaf count — the reduction is
     * breadth-first per level, not over a compacted active-node list). So an
     * indirect dispatch here would still need 2^d threads = no win. This is the
     * residual O(2^D) term and the practical ceiling (~D=24-25); bounding it would
     * require a sparse CBT representation (separate effort).
     */
    runReduction(): void {
        for (let depth = this.maxDepth - 1; depth >= 0; depth--) {
            const count = Math.pow(2, depth);
            const groups = Math.max(1, Math.ceil(count / WORKGROUP_SIZE));
            // Cap X at the WebGPU per-dimension workgroup limit (65535); spill the
            // overflow into Y (the shader reconstructs the linear index). Needed at
            // depth >= 24 (groups > 65535). For smaller levels gy = 1 (unchanged).
            const MAX_DIM = 65535;
            const gy = Math.ceil(groups / MAX_DIM);
            const gx = Math.ceil(groups / gy);
            this.reduction.setUniformBuffer('reduceParams', this.levelParams[depth]);
            this.reduction.dispatch(gx, gy, 1);
        }
    }

    /**
     * Read just the live leaf count (the heap root value) back to the CPU. The root
     * value lives in the first few bytes of the heap, so this reads a tiny prefix
     * rather than the whole buffer — cheap enough to poll for HUD telemetry. Uses a
     * non-forced read (resolves over the normal render loop, no pipeline stall).
     */
    async readNodeCount(): Promise<number> {
        const bytes = (await this.heapBuffer.read(0, 16)) as Uint8Array;
        const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
        // cbt_heapRead(1, 0): bitOffset = cbt_bitID(1,0) = 2 + (D+1) = D+3, bitCount = D+1.
        const bitOffset = this.maxDepth + 3;
        const bitCount = this.maxDepth + 1;
        const w = bitOffset >>> 5;
        const b = bitOffset & 31;
        const mask = (n: number) => (n >= 32 ? 0xffffffff : ((1 << n) - 1) >>> 0);
        const first = Math.min(bitCount, 32 - b);
        let r = (u32[w] >>> b) & mask(first);
        if (first < bitCount) {
            r = (r | ((u32[w + 1] & mask(bitCount - first)) << first)) >>> 0;
        }
        return r >>> 0;
    }

    dispose(): void {
        for (const ubo of this.levelParams) ubo.dispose();
        this.levelParams.length = 0;
        this.updateParams.dispose();
        this.dispatchArgs.dispose();
        this.heapBuffer.dispose();
    }
}
