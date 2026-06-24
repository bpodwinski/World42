/**
 * OCBT concurrent-topology kernel — drives the GPU bisector engine (the WGSL port of
 * `update_utilities.hlsl`) on a real WebGPU device. Owns every StorageBuffer from
 * `engineLayout()`, builds each compute pass, uploads the octahedron seed, and runs
 * one refinement frame = Reset → Classify → Split → Allocate → CopyNeighbors → Bisect →
 * (ping-pong swap) → PropagateBisect → pool reduce, exactly the order of
 * `mesh_updater.cpp` (minus the indirect-dispatch/indexation/eval-leb machinery, which
 * is pure perf/render and orthogonal to topological correctness).
 *
 * Scope: this is the Phase 1c GPU↔mirror cross-check engine. Refinement is driven by a
 * deterministic, FP-free target-heapID ancestry predicate (set via {@link setTargets})
 * so the concurrent GPU and the sequential CPU oracle (`OcbtTopology`) provably
 * converge to the same conforming leaf set. Passes dispatch DIRECTLY over the full pool
 * capacity with in-shader guards — correct (just not yet cost-optimal); the indirect
 * dispatch is a later perf pass.
 *
 * WebGPU only. Mirrors the buffer-creation-flag and whenReady/readback patterns of
 * `GpuCbtKernel` and `OcbtPoolGpuHarness`.
 */
import {
    ComputeShader,
    Constants,
    StorageBuffer,
    UniformBuffer,
    type WebGPUEngine
} from '@babylonjs/core';
import ocbtU64Wgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_u64.wgsl';
import ocbtPoolWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_pool.wgsl';
import ocbtTopoCommonWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_common.wgsl';
import ocbtTopoResetWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_reset.compute.wgsl';
import ocbtTopoClassifyWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_classify.compute.wgsl';
import ocbtTopoSplitWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_split.compute.wgsl';
import ocbtTopoAllocateWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_allocate.compute.wgsl';
import ocbtTopoCopyNeighborsWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_copy_neighbors.compute.wgsl';
import ocbtTopoBisectWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_bisect.compute.wgsl';
import ocbtTopoPropagateBisectWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_propagate_bisect.compute.wgsl';
import ocbtPoolReduceWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_pool_reduce.compute.wgsl';
import {
    engineLayout,
    engineWgslPreamble,
    buildEngineSeed,
    HEAP_ID_WORDS,
    NEIGHBORS_WORDS,
    BISECTOR_DATA_WORDS,
    OCBT_INVALID
} from './ocbt_engine_buffers';
import { log2PowerOfTwo } from './ocbt_pool';

const WORKGROUP_SIZE = 256;
const MAX_DIM = 65535;

/** Number of octahedron faces (root bisectors). */
export const OCBT_FACE_COUNT = 8;

/** Live topology snapshot read back from the GPU for the cross-check. */
export interface OcbtGpuState {
    /** Per-slot heap id (0 = dead slot). Length = capacity. */
    heapID: Float64Array;
    /** Per-slot neighbor triples (n0,n1,n2); OCBT_INVALID = none. Length = capacity*3. */
    neighbors: Uint32Array;
    /** Live (allocated) slot count = pool_tree[1]. */
    count: number;
}

/** Split a 1D workgroup count into a 2D grid within the per-dimension limit. */
function grid2D(groups: number): [number, number] {
    const g = Math.max(1, groups);
    const gy = Math.ceil(g / MAX_DIM);
    const gx = Math.ceil(g / gy);
    return [gx, gy];
}

const STORAGE = Constants.BUFFER_CREATIONFLAG_STORAGE;
const WRITE = Constants.BUFFER_CREATIONFLAG_WRITE;
const READ = Constants.BUFFER_CREATIONFLAG_READ;

export class OcbtTopologyKernel {
    readonly capacity: number;
    readonly depth: number;

    private readonly engine: WebGPUEngine;

    // Buffers.
    private readonly poolBitfield: StorageBuffer;
    private readonly poolTree: StorageBuffer;
    private readonly heapID: StorageBuffer;
    private readonly nbA: StorageBuffer;
    private readonly nbB: StorageBuffer;
    private readonly bisectorData: StorageBuffer;
    private readonly classification: StorageBuffer;
    private readonly allocateBuf: StorageBuffer;
    private readonly propagate: StorageBuffer;
    private readonly memory: StorageBuffer;
    private readonly faceTargets: StorageBuffer;

    // Passes.
    private readonly reduce: ComputeShader;
    private readonly reset: ComputeShader;
    private readonly classify: ComputeShader;
    private readonly split: ComputeShader;
    private readonly allocate: ComputeShader;
    private readonly copy: ComputeShader;
    private readonly bisect: ComputeShader;
    private readonly propagateBisect: ComputeShader;

    /** One UBO per reduce level 0..depth (index `depth` = leaf prepass). */
    private readonly levelParams: UniformBuffer[] = [];

    /** Ping-pong parity: 0 => current = nbA, 1 => current = nbB. */
    private parity = 0;
    /** The neighbor buffer currently holding the live topology (read back here). */
    private liveNeighbors: StorageBuffer;

    constructor(engine: WebGPUEngine, capacity: number) {
        this.engine = engine;
        this.capacity = capacity;
        this.depth = log2PowerOfTwo(capacity);
        const layout = engineLayout(capacity);
        const preamble = engineWgslPreamble(capacity);
        const compose = (...parts: string[]) => [preamble, ...parts].join('\n');

        const mk = (bytes: number, flags: number, name: string) =>
            new StorageBuffer(engine, bytes, flags, name);

        this.poolBitfield = mk(layout.bitfieldBytes, STORAGE | WRITE, 'ocbt_topo_bitfield');
        this.poolTree = mk(layout.treeBytes, STORAGE | READ | WRITE, 'ocbt_topo_tree');
        this.heapID = mk(layout.heapIdBytes, STORAGE | READ | WRITE, 'ocbt_topo_heapid');
        this.nbA = mk(layout.neighborsBytes, STORAGE | READ | WRITE, 'ocbt_topo_nbA');
        this.nbB = mk(layout.neighborsBytes, STORAGE | READ | WRITE, 'ocbt_topo_nbB');
        this.bisectorData = mk(layout.bisectorDataBytes, STORAGE | WRITE, 'ocbt_topo_bisectordata');
        this.classification = mk(layout.classificationBytes, STORAGE | WRITE, 'ocbt_topo_classify');
        this.allocateBuf = mk(layout.allocateBytes, STORAGE | WRITE, 'ocbt_topo_allocate');
        this.propagate = mk(layout.propagateBytes, STORAGE | WRITE, 'ocbt_topo_propagate');
        this.memory = mk(layout.memoryBytes, STORAGE | WRITE, 'ocbt_topo_memory');
        this.faceTargets = mk(OCBT_FACE_COUNT * 4, STORAGE | WRITE, 'ocbt_topo_facetargets');
        this.liveNeighbors = this.nbA;

        const onErr = (tag: string) => (_e: unknown, errors: string) => {
            // eslint-disable-next-line no-console
            console.error(`[OcbtTopologyKernel] ${tag} compile error:\n${errors}`);
        };

        // --- reduce (reuse the pool reduce shader) ---
        this.reduce = new ComputeShader(
            'ocbt_topo_reduce',
            engine,
            { computeSource: compose(ocbtPoolWgsl, ocbtPoolReduceWgsl) },
            {
                bindingsMapping: {
                    pool_bitfield: { group: 0, binding: 0 },
                    pool_tree: { group: 0, binding: 1 },
                    reduceParams: { group: 0, binding: 2 }
                }
            }
        );
        this.reduce.onError = onErr('reduce');
        this.reduce.setStorageBuffer('pool_bitfield', this.poolBitfield);
        this.reduce.setStorageBuffer('pool_tree', this.poolTree);

        // --- reset ---
        this.reset = new ComputeShader(
            'ocbt_topo_reset',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtPoolWgsl, ocbtTopoCommonWgsl, ocbtTopoResetWgsl) },
            {
                bindingsMapping: {
                    pool_tree: { group: 0, binding: 1 },
                    classification: { group: 0, binding: 6 },
                    allocate: { group: 0, binding: 8 },
                    propagate: { group: 0, binding: 9 },
                    memory: { group: 0, binding: 10 }
                }
            }
        );
        this.reset.onError = onErr('reset');
        this.reset.setStorageBuffer('pool_tree', this.poolTree);
        this.reset.setStorageBuffer('classification', this.classification);
        this.reset.setStorageBuffer('allocate', this.allocateBuf);
        this.reset.setStorageBuffer('propagate', this.propagate);
        this.reset.setStorageBuffer('memory', this.memory);

        // --- classify ---
        this.classify = new ComputeShader(
            'ocbt_topo_classify',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtTopoCommonWgsl, ocbtTopoClassifyWgsl) },
            {
                bindingsMapping: {
                    heapID: { group: 0, binding: 2 },
                    bisectorData: { group: 0, binding: 5 },
                    classification: { group: 0, binding: 6 },
                    faceTarget: { group: 0, binding: 18 }
                }
            }
        );
        this.classify.onError = onErr('classify');
        this.classify.setStorageBuffer('heapID', this.heapID);
        this.classify.setStorageBuffer('bisectorData', this.bisectorData);
        this.classify.setStorageBuffer('classification', this.classification);
        this.classify.setStorageBuffer('faceTarget', this.faceTargets);

        // --- split ---
        this.split = new ComputeShader(
            'ocbt_topo_split',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtTopoCommonWgsl, ocbtTopoSplitWgsl) },
            {
                bindingsMapping: {
                    heapID: { group: 0, binding: 2 },
                    neighbors: { group: 0, binding: 3 },
                    bisectorData: { group: 0, binding: 5 },
                    classification: { group: 0, binding: 6 },
                    allocate: { group: 0, binding: 8 },
                    memory: { group: 0, binding: 10 }
                }
            }
        );
        this.split.onError = onErr('split');
        this.split.setStorageBuffer('heapID', this.heapID);
        this.split.setStorageBuffer('bisectorData', this.bisectorData);
        this.split.setStorageBuffer('classification', this.classification);
        this.split.setStorageBuffer('allocate', this.allocateBuf);
        this.split.setStorageBuffer('memory', this.memory);

        // --- allocate ---
        this.allocate = new ComputeShader(
            'ocbt_topo_allocate',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtPoolWgsl, ocbtTopoCommonWgsl, ocbtTopoAllocateWgsl) },
            {
                bindingsMapping: {
                    pool_tree: { group: 0, binding: 1 },
                    bisectorData: { group: 0, binding: 5 },
                    allocate: { group: 0, binding: 8 },
                    memory: { group: 0, binding: 10 }
                }
            }
        );
        this.allocate.onError = onErr('allocate');
        this.allocate.setStorageBuffer('pool_tree', this.poolTree);
        this.allocate.setStorageBuffer('bisectorData', this.bisectorData);
        this.allocate.setStorageBuffer('allocate', this.allocateBuf);
        this.allocate.setStorageBuffer('memory', this.memory);

        // --- copy neighbors (ping-pong buffers bound per frame) ---
        this.copy = new ComputeShader(
            'ocbt_topo_copy',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtTopoCommonWgsl, ocbtTopoCopyNeighborsWgsl) },
            {
                bindingsMapping: {
                    nbIn: { group: 0, binding: 3 },
                    nbOut: { group: 0, binding: 4 }
                }
            }
        );
        this.copy.onError = onErr('copy');

        // --- bisect (ping-pong buffers bound per frame) ---
        this.bisect = new ComputeShader(
            'ocbt_topo_bisect',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtPoolWgsl, ocbtTopoCommonWgsl, ocbtTopoBisectWgsl) },
            {
                bindingsMapping: {
                    pool_bitfield: { group: 0, binding: 0 },
                    heapID: { group: 0, binding: 2 },
                    neighbors: { group: 0, binding: 3 },
                    neighborsOut: { group: 0, binding: 4 },
                    bisectorData: { group: 0, binding: 5 },
                    allocate: { group: 0, binding: 8 },
                    propagate: { group: 0, binding: 9 }
                }
            }
        );
        this.bisect.onError = onErr('bisect');
        this.bisect.setStorageBuffer('pool_bitfield', this.poolBitfield);
        this.bisect.setStorageBuffer('heapID', this.heapID);
        this.bisect.setStorageBuffer('bisectorData', this.bisectorData);
        this.bisect.setStorageBuffer('allocate', this.allocateBuf);
        this.bisect.setStorageBuffer('propagate', this.propagate);

        // --- propagate bisect (neighbor buffer = post-swap "current", bound per frame) ---
        this.propagateBisect = new ComputeShader(
            'ocbt_topo_propagate',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtTopoCommonWgsl, ocbtTopoPropagateBisectWgsl) },
            {
                bindingsMapping: {
                    neighbors: { group: 0, binding: 3 },
                    bisectorData: { group: 0, binding: 5 },
                    propagate: { group: 0, binding: 9 }
                }
            }
        );
        this.propagateBisect.onError = onErr('propagate');
        this.propagateBisect.setStorageBuffer('bisectorData', this.bisectorData);
        this.propagateBisect.setStorageBuffer('propagate', this.propagate);

        // One UBO per reduce level (0..depth). Reusing one UBO across same-submit
        // dispatches coalesces to the last value, so each level needs its own.
        for (let level = 0; level <= this.depth; level++) {
            const ubo = new UniformBuffer(engine, undefined, undefined, `ocbt_topo_reduce_lvl_${level}`);
            ubo.addUniform('data', 4);
            ubo.updateInt4('data', level, 0, 0, 0);
            ubo.update();
            this.levelParams[level] = ubo;
        }
    }

    async whenReady(timeoutMs = 12000): Promise<void> {
        const shaders = [
            this.reduce,
            this.reset,
            this.classify,
            this.split,
            this.allocate,
            this.copy,
            this.bisect,
            this.propagateBisect
        ];
        const end = performance.now() + timeoutMs;
        while (!shaders.every((s) => s.isReady())) {
            if (performance.now() > end) {
                throw new Error('OcbtTopologyKernel compute shaders not ready (timeout)');
            }
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    /**
     * Upload the octahedron seed (8 roots at slots 0..7) and reset ping-pong state.
     * Buffers are written FULL-SIZE (zero-padded past the 8-slot prefix) — the proven
     * StorageBuffer.update pattern in this project always writes the whole buffer.
     */
    uploadSeed(): void {
        const seed = buildEngineSeed(this.capacity);
        const heap = new Uint32Array(this.capacity * HEAP_ID_WORDS);
        heap.set(seed.heapID);
        const nb = new Uint32Array(this.capacity * NEIGHBORS_WORDS);
        nb.set(seed.neighbors);
        const bd = new Uint32Array(this.capacity * BISECTOR_DATA_WORDS);
        bd.set(seed.bisectorData);
        this.poolBitfield.update(seed.bitfield); // already full-size
        this.heapID.update(heap);
        this.nbA.update(nb);
        this.bisectorData.update(bd);
        this.parity = 0;
        this.liveNeighbors = this.nbA;
        // Self-prime: the pool sum-tree must reflect the seeded 8-slot bitfield before
        // frame 0's Reset (free-slot budget) and Allocate (decode_bit_complement) run.
        this.runReduce();
    }

    /**
     * Set per-face target LEVELS (depth - 3): each face refines uniformly until its
     * leaves reach the given level, plus the conformity closure at the 12 octahedron
     * seams. `levels[f]` is the target level for face f (0..7).
     */
    setFaceDepths(levels: ReadonlyArray<number>): void {
        if (levels.length !== OCBT_FACE_COUNT) {
            throw new Error(`OcbtTopologyKernel.setFaceDepths needs ${OCBT_FACE_COUNT} levels`);
        }
        this.faceTargets.update(new Uint32Array(levels.map((l) => l >>> 0)));
    }

    /** Rebuild the pool sum-tree from the bitfield (leaf prepass, then levels D-1..0). */
    runReduce(): void {
        this.reduce.setUniformBuffer('reduceParams', this.levelParams[this.depth]);
        let [gx, gy] = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        this.reduce.dispatch(gx, gy, 1);
        for (let level = this.depth - 1; level >= 0; level--) {
            const count = 1 << level;
            [gx, gy] = grid2D(Math.ceil(count / WORKGROUP_SIZE));
            this.reduce.setUniformBuffer('reduceParams', this.levelParams[level]);
            this.reduce.dispatch(gx, gy, 1);
        }
    }

    /** Run one refinement frame (the mesh_updater pass order). */
    runFrame(): void {
        const current = this.parity === 0 ? this.nbA : this.nbB;
        const next = this.parity === 0 ? this.nbB : this.nbA;

        // Re-point the ping-pong-sensitive passes for this frame's parity.
        this.split.setStorageBuffer('neighbors', current);
        this.copy.setStorageBuffer('nbIn', current);
        this.copy.setStorageBuffer('nbOut', next);
        this.bisect.setStorageBuffer('neighbors', current);
        this.bisect.setStorageBuffer('neighborsOut', next);
        // PropagateBisect runs AFTER the conceptual swap -> operates on `next`.
        this.propagateBisect.setStorageBuffer('neighbors', next);

        const full = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        const nbWords = grid2D(Math.ceil((this.capacity * NEIGHBORS_WORDS) / WORKGROUP_SIZE));

        this.reset.dispatch(1, 1, 1);
        this.classify.dispatch(full[0], full[1], 1);
        this.split.dispatch(full[0], full[1], 1);
        this.allocate.dispatch(full[0], full[1], 1);
        this.copy.dispatch(nbWords[0], nbWords[1], 1);
        this.bisect.dispatch(full[0], full[1], 1);
        this.propagateBisect.dispatch(full[0], full[1], 1);

        // Rebuild the tree from the bits Bisect set, ready for next frame's Allocate.
        this.runReduce();

        this.liveNeighbors = next;
        this.parity ^= 1;
    }

    /** Read the live topology back to the CPU for the cross-check (forced flush). */
    async readState(): Promise<OcbtGpuState> {
        const heapBytes = (await this.heapID.read(0, undefined, undefined, true)) as Uint8Array;
        const nbBytes = (await this.liveNeighbors.read(0, undefined, undefined, true)) as Uint8Array;
        const treeBytes = (await this.poolTree.read(0, 16, undefined, true)) as Uint8Array;
        const hu = new Uint32Array(heapBytes.buffer, heapBytes.byteOffset, heapBytes.byteLength >> 2);
        const nu = new Uint32Array(nbBytes.buffer, nbBytes.byteOffset, nbBytes.byteLength >> 2);
        const tu = new Uint32Array(treeBytes.buffer, treeBytes.byteOffset, treeBytes.byteLength >> 2);

        const heapID = new Float64Array(this.capacity);
        for (let s = 0; s < this.capacity; s++) {
            const lo = hu[s * HEAP_ID_WORDS + 0];
            const hi = hu[s * HEAP_ID_WORDS + 1];
            heapID[s] = hi * 0x1_0000_0000 + lo;
        }
        const neighbors = new Uint32Array(nu.subarray(0, this.capacity * NEIGHBORS_WORDS));
        return { heapID, neighbors, count: tu[1] };
    }

    /** Sentinel value for "no neighbor" in the readback neighbors array. */
    static readonly INVALID = OCBT_INVALID;

    dispose(): void {
        for (const ubo of this.levelParams) ubo.dispose();
        this.levelParams.length = 0;
        this.poolBitfield.dispose();
        this.poolTree.dispose();
        this.heapID.dispose();
        this.nbA.dispose();
        this.nbB.dispose();
        this.bisectorData.dispose();
        this.classification.dispose();
        this.allocateBuf.dispose();
        this.propagate.dispose();
        this.memory.dispose();
        this.faceTargets.dispose();
    }
}
