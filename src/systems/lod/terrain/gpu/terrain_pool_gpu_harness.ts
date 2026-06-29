/**
 * GPU pool harness — drives the OCBT pool core (`ocbt_pool.wgsl`) on a real WebGPU
 * device: uploads a bitfield, runs the leaf prepass + level reduce, then the decode
 * pass, and reads `pool_tree` and `decodeOut` back. Used by `ocbt_pool_gpu_test_main`
 * to cross-check the GPU allocator against the CPU oracle (`OcbtPool`), closing the
 * Phase 0 verification ("readback GPU reduce == mirror"). Reuses the compute/readback
 * patterns from `gpu/gpu_cbt_kernel.ts` (composeCompute, per-level UBOs, 2D dispatch
 * spill, StorageBuffer.read).
 *
 * WebGPU only (compute). Capacity is the pool slot count (power of two).
 */
import {
    ComputeShader,
    Constants,
    StorageBuffer,
    UniformBuffer,
    type WebGPUEngine
} from '@babylonjs/core';
import ocbtPoolWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_pool.wgsl';
import ocbtPoolReduceWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_pool_reduce.compute.wgsl';
import ocbtPoolDecodeWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_pool_decode.compute.wgsl';
import { poolLayout, poolWgslPreamble } from './ocbt_buffers';
import { log2PowerOfTwo } from './ocbt_pool';

const WORKGROUP_SIZE = 256;
const MAX_DIM = 65535;

/** Split a 1D workgroup count into a 2D grid within the per-dimension limit. */
function grid2D(groups: number): [number, number] {
    const g = Math.max(1, groups);
    const gy = Math.ceil(g / MAX_DIM);
    const gx = Math.ceil(g / gy);
    return [gx, gy];
}

export interface PoolGpuRunResult {
    /** Full sum-tree read back from the GPU (length 2*capacity). */
    tree: Uint32Array;
    /** Decode outputs: [0,count)=decodeBit, [count,capacity)=decodeBitComplement. */
    decodeOut: Uint32Array;
    /** Allocated count = tree[1]. */
    count: number;
}

export class OcbtPoolGpuHarness {
    readonly capacity: number;
    readonly depth: number;

    private readonly engine: WebGPUEngine;
    private readonly bitfield: StorageBuffer;
    private readonly tree: StorageBuffer;
    private readonly decodeBuf: StorageBuffer;
    private readonly reduce: ComputeShader;
    private readonly decode: ComputeShader;
    /** One UBO per level 0..depth (index `depth` = the leaf prepass). */
    private readonly levelParams: UniformBuffer[] = [];

    constructor(engine: WebGPUEngine, capacity: number) {
        this.engine = engine;
        this.capacity = capacity;
        this.depth = log2PowerOfTwo(capacity);
        const layout = poolLayout(capacity);
        const preamble = poolWgslPreamble(capacity);

        this.bitfield = new StorageBuffer(
            engine,
            layout.bitfieldBytes,
            // STORAGE: compute. WRITE (CopyDst): CPU uploads the seed bitfield.
            Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_WRITE,
            'ocbt_pool_bitfield'
        );
        this.tree = new StorageBuffer(
            engine,
            layout.treeBytes,
            // STORAGE: compute fills it. READ (CopySrc): readback. WRITE (CopyDst):
            // Babylon zero-initializes the buffer via writeBuffer, which needs CopyDst.
            Constants.BUFFER_CREATIONFLAG_STORAGE |
                Constants.BUFFER_CREATIONFLAG_READ |
                Constants.BUFFER_CREATIONFLAG_WRITE,
            'ocbt_pool_tree'
        );
        this.decodeBuf = new StorageBuffer(
            engine,
            capacity * 4,
            Constants.BUFFER_CREATIONFLAG_STORAGE |
                Constants.BUFFER_CREATIONFLAG_READ |
                Constants.BUFFER_CREATIONFLAG_WRITE,
            'ocbt_pool_decode'
        );

        this.reduce = new ComputeShader(
            'ocbt_pool_reduce',
            engine,
            { computeSource: preamble + ocbtPoolWgsl + '\n' + ocbtPoolReduceWgsl },
            {
                bindingsMapping: {
                    pool_bitfield: { group: 0, binding: 0 },
                    pool_tree: { group: 0, binding: 1 },
                    reduceParams: { group: 0, binding: 2 }
                }
            }
        );
        this.reduce.onError = (_e, errors) => {
            // eslint-disable-next-line no-console
            console.error(`[OcbtPoolGpuHarness] reduce compile error:\n${errors}`);
        };
        this.reduce.setStorageBuffer('pool_bitfield', this.bitfield);
        this.reduce.setStorageBuffer('pool_tree', this.tree);

        // Decode reads only pool_tree (binding 1) + decodeOut (binding 2). The shared
        // core also declares pool_bitfield at binding 0, but decode never touches it,
        // so reflection strips it from the layout — do NOT bind it here (binding an
        // absent slot invalidates the whole bind group).
        this.decode = new ComputeShader(
            'ocbt_pool_decode',
            engine,
            { computeSource: preamble + ocbtPoolWgsl + '\n' + ocbtPoolDecodeWgsl },
            {
                bindingsMapping: {
                    pool_tree: { group: 0, binding: 1 },
                    decodeOut: { group: 0, binding: 2 }
                }
            }
        );
        this.decode.onError = (_e, errors) => {
            // eslint-disable-next-line no-console
            console.error(`[OcbtPoolGpuHarness] decode compile error:\n${errors}`);
        };
        this.decode.setStorageBuffer('pool_tree', this.tree);
        this.decode.setStorageBuffer('decodeOut', this.decodeBuf);

        // One UBO per level (0..depth). Reusing a single UBO across same-submit
        // dispatches coalesces to the last value, so each level needs its own.
        for (let level = 0; level <= this.depth; level++) {
            const ubo = new UniformBuffer(engine, undefined, undefined, `ocbt_reduce_lvl_${level}`);
            ubo.addUniform('data', 4);
            ubo.updateInt4('data', level, 0, 0, 0);
            ubo.update();
            this.levelParams[level] = ubo;
        }
    }

    async whenReady(timeoutMs = 8000): Promise<void> {
        const end = performance.now() + timeoutMs;
        while (!this.reduce.isReady() || !this.decode.isReady()) {
            if (performance.now() > end) {
                throw new Error('OcbtPoolGpuHarness compute shaders not ready (timeout)');
            }
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    /** Pack an allocated-slot list into the bitfield word layout (capacity/32 words). */
    private packBitfield(allocatedSlots: Iterable<number>): Uint32Array {
        const words = new Uint32Array(this.capacity >>> 5 || 1);
        for (const slot of allocatedSlots) {
            words[slot >>> 5] |= 1 << (slot & 31);
        }
        return words;
    }

    /**
     * Upload the given allocated slots, run reduce + decode on the GPU, and read the
     * tree and decode outputs back. The returned arrays are compared against `OcbtPool`
     * by the caller.
     */
    async run(allocatedSlots: Iterable<number>): Promise<PoolGpuRunResult> {
        this.bitfield.update(this.packBitfield(allocatedSlots));

        // Leaf prepass (level == depth), then internal levels depth-1 .. 0.
        this.reduce.setUniformBuffer('reduceParams', this.levelParams[this.depth]);
        let [gx, gy] = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        this.reduce.dispatch(gx, gy, 1);
        for (let level = this.depth - 1; level >= 0; level--) {
            const count = 1 << level;
            [gx, gy] = grid2D(Math.ceil(count / WORKGROUP_SIZE));
            this.reduce.setUniformBuffer('reduceParams', this.levelParams[level]);
            this.reduce.dispatch(gx, gy, 1);
        }

        // Decode reads pool_count() from the freshly-reduced tree.
        [gx, gy] = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        this.decode.dispatch(gx, gy, 1);

        // noDelay = true forces flushFramebuffer (submits the recorded compute passes)
        // then maps — required here because there is no render loop to submit them.
        const treeBytes = (await this.tree.read(0, undefined, undefined, true)) as Uint8Array;
        const decodeBytes = (await this.decodeBuf.read(0, undefined, undefined, true)) as Uint8Array;
        const tree = new Uint32Array(treeBytes.buffer, treeBytes.byteOffset, treeBytes.byteLength >> 2);
        const decodeOut = new Uint32Array(
            decodeBytes.buffer,
            decodeBytes.byteOffset,
            decodeBytes.byteLength >> 2
        );
        return { tree, decodeOut, count: tree[1] };
    }

    dispose(): void {
        for (const ubo of this.levelParams) ubo.dispose();
        this.levelParams.length = 0;
        this.bitfield.dispose();
        this.tree.dispose();
        this.decodeBuf.dispose();
    }
}
