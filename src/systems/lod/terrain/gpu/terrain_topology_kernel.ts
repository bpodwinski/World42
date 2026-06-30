/**
 * TERRAIN concurrent-topology kernel — drives the GPU bisector engine (the WGSL port of
 * `update_utilities.hlsl`) on a real WebGPU device. Owns every StorageBuffer from
 * `engineLayout()`, builds each compute pass, uploads the octahedron seed, and runs
 * one refinement frame = Reset → Classify → Split → Allocate → CopyNeighbors → Bisect →
 * (ping-pong swap) → PropagateBisect → pool reduce, exactly the order of
 * `mesh_updater.cpp` (minus the indirect-dispatch/indexation/eval-leb machinery, which
 * is pure perf/render and orthogonal to topological correctness).
 *
 * Scope: this is the Phase 1c GPU↔mirror cross-check engine. Refinement is driven by a
 * deterministic, FP-free target-heapID ancestry predicate (set via {@link setTargets})
 * so the concurrent GPU and the sequential CPU oracle (`TerrainTopology`) provably
 * converge to the same conforming leaf set. Passes dispatch DIRECTLY over the full pool
 * capacity with in-shader guards — correct (just not yet cost-optimal); the indirect
 * dispatch is a later perf pass.
 *
 * WebGPU only. Mirrors the buffer-creation-flag and whenReady/readback patterns of
 * `GpuTerrainKernel` and `TerrainPoolGpuHarness`.
 */
import {
    ComputeShader,
    Constants,
    StorageBuffer,
    UniformBuffer,
    type WebGPUEngine
} from '@babylonjs/core';
import terrainU64Wgsl from '../../../../assets/shaders/terrain/engine/terrain_u64.wgsl';
import terrainPoolWgsl from '../../../../assets/shaders/terrain/engine/terrain_pool.wgsl';
import terrainTopoCommonWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_common.wgsl';
import terrainTopoResetWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_reset.compute.wgsl';
import terrainTopoClassifyWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_classify.compute.wgsl';
import terrainTopoClassifyMetricWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_classify_metric.compute.wgsl';
import terrainTopoSplitWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_split.compute.wgsl';
import terrainTopoAllocateWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_allocate.compute.wgsl';
import terrainTopoCopyNeighborsWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_copy_neighbors.compute.wgsl';
import terrainTopoBisectWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_bisect.compute.wgsl';
import terrainTopoPropagateBisectWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_propagate_bisect.compute.wgsl';
import terrainTopoPrepareSimplifyWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_prepare_simplify.compute.wgsl';
import terrainTopoSimplifyWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_simplify.compute.wgsl';
import terrainTopoPropagateSimplifyWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_propagate_simplify.compute.wgsl';
import terrainPoolReduceWgsl from '../../../../assets/shaders/terrain/engine/terrain_pool_reduce.compute.wgsl';
import terrainNoiseWgsl from '../../../../assets/shaders/terrain/gpu/terrain_noise.wgsl';
import {
    buildPerm,
    craterHeaderWgsl,
    DEFAULT_CRATERS,
    type CraterParams,
    type NoiseParams
} from '../terrain_noise';
import terrainEvalLebWgsl from '../../../../assets/shaders/terrain/engine/terrain_eval_leb.wgsl';
import terrainF64Wgsl from '../../../../assets/shaders/terrain/engine/terrain_f64.wgsl';
import terrainNoiseDf64Wgsl from '../../../../assets/shaders/terrain/engine/terrain_noise_df64.wgsl';
import terrainTopoEvalLebWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_eval_leb.compute.wgsl';
import terrainTopoEvalLebF64Wgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_eval_leb_f64.compute.wgsl';
import terrainTopoCompactWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_compact.compute.wgsl';
import terrainTopoPrepareIndirectWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_prepare_indirect.compute.wgsl';
import terrainTopoPrepareEvalLebWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_prepare_eval_leb.compute.wgsl';
import terrainTopoEvalLebF64ActiveWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_eval_leb_f64_active.compute.wgsl';
import terrainTopoEvalLebF64DeltaWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_eval_leb_f64_delta.compute.wgsl';
import terrainTopoEvalLebActiveWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_eval_leb_active.compute.wgsl';
import terrainTopoEvalLebDeltaWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_eval_leb_delta.compute.wgsl';
import terrainTopoClassifyMetricActiveWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_classify_metric_active.compute.wgsl';
import terrainTopoCopyNeighborsActiveWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_copy_neighbors_active.compute.wgsl';
import terrainTopoResetDrawCountWgsl from '../../../../assets/shaders/terrain/engine/terrain_topo_reset_drawcount.compute.wgsl';
import {
    engineLayout,
    engineWgslPreamble,
    buildEngineSeed,
    HEAP_ID_WORDS,
    NEIGHBORS_WORDS,
    BISECTOR_DATA_WORDS,
    POSITIONS_WORDS,
    TERRAIN_INVALID
} from './terrain_engine_buffers';
import { log2PowerOfTwo } from './terrain_pool';

const WORKGROUP_SIZE = 256;
const MAX_DIM = 65535;

/** Number of octahedron faces (root bisectors). */
export const TERRAIN_FACE_COUNT = 8;

/** Classify metric source: deterministic per-face predicate (cross-check) or camera. */
export type TerrainClassifyMode = 'predicate' | 'metric';

/** Camera + threshold inputs for the metric classify (all in planet-local sim units). */
export interface TerrainCameraParams {
    camLocal: [number, number, number];
    radius: number;
    focalPx: number;
    splitThresholdPx: number;
    mergeThresholdPx: number;
    cullMinDot: number;
    maxLevel: number;
    /** Subdivision floor: force-refine to at least this level everywhere (keeps the planet round). */
    minLevel: number;
    /** df64->f32 noise cutoff (km): the eval uses precise df64 noise for corners within this camera
     *  distance, the cheaper f32 twin beyond it (watertight: per-corner distance, not level). */
    df64NearKm: number;
}

/** Live topology snapshot read back from the GPU for the cross-check. */
export interface TerrainGpuState {
    /** Per-slot heap id (0 = dead slot). Length = capacity. */
    heapID: Float64Array;
    /** Per-slot neighbor triples (n0,n1,n2); TERRAIN_INVALID = none. Length = capacity*3. */
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
const INDIRECT = Constants.BUFFER_CREATIONFLAG_INDIRECT;

/** Byte offset of each work-list pass's record in the indirect-args buffer (16 B/record). */
const ARG = {
    SPLIT: 0,
    ALLOCATE: 16,
    BISECT: 32,
    PROPAGATE_BISECT: 48,
    PREPARE_SIMPLIFY: 64,
    SIMPLIFY: 80,
    PROPAGATE_SIMPLIFY: 96,
    EVAL_LEB: 112,
    CLASSIFY: 128,
    COPY_NB: 144
} as const;
const ARG_RECORDS = 10;

export class TerrainTopologyKernel {
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
    private readonly simplification: StorageBuffer;
    private readonly allocateBuf: StorageBuffer;
    private readonly propagate: StorageBuffer;
    private readonly memory: StorageBuffer;
    private readonly faceTargets: StorageBuffer;
    private readonly positions: StorageBuffer;
    /** f32 words per slot in the positions buffer (9 predicate / 18 metric). */
    readonly positionsWords: number;
    /** Permutation table for the terrain-aware df64 eval (metric mode; null otherwise). */
    private readonly evalPerm: StorageBuffer | null = null;
    /** Compacted live-slot list + cursor (metric mode only; null in predicate). */
    private readonly bisectorIndices: StorageBuffer | null = null;
    private readonly drawCount: StorageBuffer | null = null;
    /** Indirect-dispatch args (7 records x 4 u32) + its builder pass (useIndirect only). */
    private readonly indirectArgs: StorageBuffer | null = null;
    private readonly prepareIndirect: ComputeShader | null = null;
    private readonly useIndirect: boolean;

    // Passes.
    private readonly reduce: ComputeShader;
    private readonly reset: ComputeShader;
    private readonly classify: ComputeShader;
    private readonly split: ComputeShader;
    private readonly allocate: ComputeShader;
    private readonly copy: ComputeShader;
    private readonly bisect: ComputeShader;
    private readonly propagateBisect: ComputeShader;
    private readonly prepareSimplify: ComputeShader;
    private readonly simplify: ComputeShader;
    private readonly propagateSimplify: ComputeShader;
    private readonly evalLeb: ComputeShader;
    /** Draw compaction (metric mode only). */
    private readonly compact: ComputeShader | null = null;
    /** Active-list EvalLeb (indirect + metric only): O(active) dispatch via bisectorIndices. */
    private readonly evalLebActive: ComputeShader | null = null;
    /** Delta EvalLeb: covers newly-allocated slots absent from the previous compact list. */
    private readonly evalLebDelta: ComputeShader | null = null;
    /** Writes the EvalLeb indirect-dispatch record (ARG.EVAL_LEB) from the draw count. */
    private readonly prepareEvalLeb: ComputeShader | null = null;
    /** Active-list Classify (metric + indirect only): O(active) dispatch via bisectorIndices. */
    private classifyActive: ComputeShader | null = null;
    /** Active-list CopyNeighbors (metric + indirect only): O(active) slot-level ping-pong copy. */
    private copyActive: ComputeShader | null = null;
    /** Zeros drawCount[0] within the GPU command buffer (after classify reads it, before compact). */
    private resetDrawCount: ComputeShader | null = null;
    /** True after the first compact has run; gates the active-list dispatch path. */
    private hasCompacted = false;

    /** One UBO per reduce level 0..depth (index `depth` = leaf prepass). */
    private readonly levelParams: UniformBuffer[] = [];

    /** Classify metric source. */
    private readonly classifyMode: TerrainClassifyMode;
    /** Camera/threshold UBO for the metric classify (null in predicate mode). */
    private readonly classifyParams: UniformBuffer | null = null;
    /** Frustum-planes UBO for the metric classify (null in predicate mode). */
    private readonly frustumParams: UniformBuffer | null = null;

    /** Ping-pong parity: 0 => current = nbA, 1 => current = nbB. */
    private parity = 0;
    /** The neighbor buffer currently holding the live topology (read back here). */
    private liveNeighbors: StorageBuffer;

    constructor(
        engine: WebGPUEngine,
        capacity: number,
        classifyMode: TerrainClassifyMode = 'predicate',
        useIndirect = false,
        noise: NoiseParams | null = null,
        craters: CraterParams = DEFAULT_CRATERS
    ) {
        this.engine = engine;
        this.capacity = capacity;
        this.classifyMode = classifyMode;
        this.useIndirect = useIndirect;
        this.depth = log2PowerOfTwo(capacity);
        const layout = engineLayout(capacity);
        const preamble = engineWgslPreamble(capacity);
        const compose = (...parts: string[]) => [preamble, ...parts].join('\n');

        const mk = (bytes: number, flags: number, name: string) =>
            new StorageBuffer(engine, bytes, flags, name);

        this.poolBitfield = mk(layout.bitfieldBytes, STORAGE | WRITE, 'terrain_topo_bitfield');
        this.poolTree = mk(layout.treeBytes, STORAGE | READ | WRITE, 'terrain_topo_tree');
        this.heapID = mk(layout.heapIdBytes, STORAGE | READ | WRITE, 'terrain_topo_heapid');
        this.nbA = mk(layout.neighborsBytes, STORAGE | READ | WRITE, 'terrain_topo_nbA');
        this.nbB = mk(layout.neighborsBytes, STORAGE | READ | WRITE, 'terrain_topo_nbB');
        this.bisectorData = mk(layout.bisectorDataBytes, STORAGE | WRITE, 'terrain_topo_bisectordata');
        this.classification = mk(layout.classificationBytes, STORAGE | WRITE, 'terrain_topo_classify');
        this.simplification = mk(layout.simplificationBytes, STORAGE | WRITE, 'terrain_topo_simplify');
        this.allocateBuf = mk(layout.allocateBytes, STORAGE | WRITE, 'terrain_topo_allocate');
        this.propagate = mk(layout.propagateBytes, STORAGE | WRITE, 'terrain_topo_propagate');
        this.memory = mk(layout.memoryBytes, STORAGE | WRITE, 'terrain_topo_memory');
        this.faceTargets = mk(TERRAIN_FACE_COUNT * 4, STORAGE | WRITE, 'terrain_topo_facetargets');
        // Metric (render) mode emits camera-relative [relative.xyz, dir.xyz] (18/slot) via
        // the df64 eval; predicate (cross-check) mode emits unit-dir corners (9/slot).
        const posWords = classifyMode === 'metric' ? 18 : POSITIONS_WORDS;
        this.positionsWords = posWords;
        this.positions = mk(capacity * posWords * 4, STORAGE | READ | WRITE, 'terrain_topo_positions');
        this.liveNeighbors = this.nbA;
        // Compaction buffers created early so the active-list EvalLeb shaders can reference
        // them inside the metric evalLeb constructor block (where noiseHeader is in scope).
        if (classifyMode === 'metric') {
            this.bisectorIndices = mk(capacity * 4, STORAGE | READ | WRITE, 'terrain_topo_indices');
            this.drawCount = mk(4, STORAGE | WRITE, 'terrain_topo_drawcount');
        }

        const onErr = (tag: string) => (_e: unknown, errors: string) => {
            // eslint-disable-next-line no-console
            console.error(`[TerrainTopologyKernel] ${tag} compile error:\n${errors}`);
        };

        // --- reduce (reuse the pool reduce shader) ---
        this.reduce = new ComputeShader(
            'terrain_topo_reduce',
            engine,
            { computeSource: compose(terrainPoolWgsl, terrainPoolReduceWgsl) },
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
            'terrain_topo_reset',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainPoolWgsl, terrainTopoCommonWgsl, terrainTopoResetWgsl) },
            {
                bindingsMapping: {
                    pool_tree: { group: 0, binding: 1 },
                    classification: { group: 0, binding: 6 },
                    simplification: { group: 0, binding: 7 },
                    allocate: { group: 0, binding: 8 },
                    propagate: { group: 0, binding: 9 },
                    memory: { group: 0, binding: 10 }
                }
            }
        );
        this.reset.onError = onErr('reset');
        this.reset.setStorageBuffer('pool_tree', this.poolTree);
        this.reset.setStorageBuffer('classification', this.classification);
        this.reset.setStorageBuffer('simplification', this.simplification);
        this.reset.setStorageBuffer('allocate', this.allocateBuf);
        this.reset.setStorageBuffer('propagate', this.propagate);
        this.reset.setStorageBuffer('memory', this.memory);

        // --- classify (predicate: faceTarget; metric: camera screen-space) ---
        if (classifyMode === 'metric') {
            this.classify = new ComputeShader(
                'terrain_topo_classify_metric',
                engine,
                { computeSource: compose(terrainU64Wgsl, terrainTopoCommonWgsl, terrainTopoClassifyMetricWgsl) },
                {
                    bindingsMapping: {
                        heapID: { group: 0, binding: 2 },
                        bisectorData: { group: 0, binding: 5 },
                        classification: { group: 0, binding: 6 },
                        cp: { group: 0, binding: 17 },
                        positions: { group: 0, binding: 19 },
                        fp: { group: 0, binding: 20 }
                    }
                }
            );
            this.classify.onError = onErr('classify(metric)');
            this.classifyParams = new UniformBuffer(engine, undefined, undefined, 'terrain_classify_params');
            this.classifyParams.addUniform('camRadius', 4);
            this.classifyParams.addUniform('thresh', 4);
            this.classifyParams.addUniform('limits', 4);
            this.classifyParams.updateFloat4('camRadius', 0, 0, 0, 1);
            this.classifyParams.updateFloat4('thresh', 1, 1e9, 1e9, -1);
            this.classifyParams.updateFloat4('limits', 0, 0, 0, 0);
            this.classifyParams.update();
            // Frustum UBO (camera-relative planet-local planes). Default disabled.
            this.frustumParams = new UniformBuffer(engine, undefined, undefined, 'terrain_frustum_params');
            this.frustumParams.addUniform('planes', 4, 6);
            this.frustumParams.addUniform('ctrl', 4);
            this.frustumParams.updateUniformArray('planes', new Float32Array(24), 24);
            this.frustumParams.updateFloat4('ctrl', 0, 1.5, 0, 0);
            this.frustumParams.update();
            this.classify.setStorageBuffer('heapID', this.heapID);
            this.classify.setStorageBuffer('bisectorData', this.bisectorData);
            this.classify.setStorageBuffer('classification', this.classification);
            this.classify.setStorageBuffer('positions', this.positions);
            this.classify.setUniformBuffer('cp', this.classifyParams);
            this.classify.setUniformBuffer('fp', this.frustumParams);
        } else {
            this.classify = new ComputeShader(
                'terrain_topo_classify',
                engine,
                { computeSource: compose(terrainU64Wgsl, terrainTopoCommonWgsl, terrainTopoClassifyWgsl) },
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
        }

        // --- split ---
        this.split = new ComputeShader(
            'terrain_topo_split',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainTopoCommonWgsl, terrainTopoSplitWgsl) },
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
            'terrain_topo_allocate',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainPoolWgsl, terrainTopoCommonWgsl, terrainTopoAllocateWgsl) },
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
            'terrain_topo_copy',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainTopoCommonWgsl, terrainTopoCopyNeighborsWgsl) },
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
            'terrain_topo_bisect',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainPoolWgsl, terrainTopoCommonWgsl, terrainTopoBisectWgsl) },
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
            'terrain_topo_propagate',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainTopoCommonWgsl, terrainTopoPropagateBisectWgsl) },
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

        // --- merge half: prepare-simplify / simplify / propagate-simplify ---
        this.prepareSimplify = new ComputeShader(
            'terrain_topo_prepare_simplify',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainTopoCommonWgsl, terrainTopoPrepareSimplifyWgsl) },
            {
                bindingsMapping: {
                    heapID: { group: 0, binding: 2 },
                    neighbors: { group: 0, binding: 3 },
                    bisectorData: { group: 0, binding: 5 },
                    classification: { group: 0, binding: 6 },
                    simplification: { group: 0, binding: 7 }
                }
            }
        );
        this.prepareSimplify.onError = onErr('prepareSimplify');
        this.prepareSimplify.setStorageBuffer('heapID', this.heapID);
        this.prepareSimplify.setStorageBuffer('bisectorData', this.bisectorData);
        this.prepareSimplify.setStorageBuffer('classification', this.classification);
        this.prepareSimplify.setStorageBuffer('simplification', this.simplification);

        this.simplify = new ComputeShader(
            'terrain_topo_simplify',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainPoolWgsl, terrainTopoCommonWgsl, terrainTopoSimplifyWgsl) },
            {
                bindingsMapping: {
                    pool_bitfield: { group: 0, binding: 0 },
                    heapID: { group: 0, binding: 2 },
                    neighbors: { group: 0, binding: 3 },
                    bisectorData: { group: 0, binding: 5 },
                    simplification: { group: 0, binding: 7 },
                    propagate: { group: 0, binding: 9 }
                }
            }
        );
        this.simplify.onError = onErr('simplify');
        this.simplify.setStorageBuffer('pool_bitfield', this.poolBitfield);
        this.simplify.setStorageBuffer('heapID', this.heapID);
        this.simplify.setStorageBuffer('bisectorData', this.bisectorData);
        this.simplify.setStorageBuffer('simplification', this.simplification);
        this.simplify.setStorageBuffer('propagate', this.propagate);

        this.propagateSimplify = new ComputeShader(
            'terrain_topo_propagate_simplify',
            engine,
            { computeSource: compose(terrainU64Wgsl, terrainTopoCommonWgsl, terrainTopoPropagateSimplifyWgsl) },
            {
                bindingsMapping: {
                    heapID: { group: 0, binding: 2 },
                    neighbors: { group: 0, binding: 3 },
                    bisectorData: { group: 0, binding: 5 },
                    propagate: { group: 0, binding: 9 }
                }
            }
        );
        this.propagateSimplify.onError = onErr('propagateSimplify');
        this.propagateSimplify.setStorageBuffer('heapID', this.heapID);
        this.propagateSimplify.setStorageBuffer('bisectorData', this.bisectorData);
        this.propagateSimplify.setStorageBuffer('propagate', this.propagate);

        // --- eval-leb: predicate = f32 unit-dir corners (9/slot, for the cross-check's
        // check D); metric = df64 camera-relative [relative,dir] (18/slot, for render). ---
        if (classifyMode === 'metric') {
            // Terrain-aware decode: the df64 eval bakes the SAME noise the render uses and
            // displaces each corner radially by terrainFbmHeight(dir). So `positions` holds the
            // real terrain surface (not the smooth sphere) and the whole classify — screenPx,
            // frustum, horizon — is terrain-aware. terrain_noise.wgsl needs the baked TERRAIN_* fbm
            // constants + the terrainPerm storage buffer declared BEFORE it.
            const n = noise;
            const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
            const noiseHeader = n
                ? [
                      `const TERRAIN_OCTAVES : i32 = ${Math.max(0, Math.floor(n.octaves))};`,
                      `const TERRAIN_BASE_FREQ : f32 = ${f(n.baseFrequency)};`,
                      `const TERRAIN_BASE_AMP : f32 = ${f(n.baseAmplitude)};`,
                      `const TERRAIN_LACUNARITY : f32 = ${f(n.lacunarity)};`,
                      `const TERRAIN_PERSISTENCE : f32 = ${f(n.persistence)};`,
                      `const TERRAIN_GLOBAL_AMP : f32 = ${f(n.globalAmplitude)};`,
                      `const TERRAIN_DETAIL_OCTAVES : i32 = ${Math.max(0, Math.floor(n.detailOctaves ?? 0))};`,
                      `const TERRAIN_DETAIL_RANGE : f32 = ${f(n.detailRange ?? 60)};`,
                      // Crater consts + craterParams() from the active CraterParams (same single
                      // source the render material bakes), so the df64 vertex height matches it.
                      craterHeaderWgsl(craters),
                      '@group(0) @binding(21) var<storage, read> terrainPerm : array<u32>;'
                  ].join('\n')
                : [
                      // No noise configured -> zero relief (smooth sphere), still valid WGSL.
                      'const TERRAIN_OCTAVES : i32 = 0;',
                      'const TERRAIN_BASE_FREQ : f32 = 1.0;',
                      'const TERRAIN_BASE_AMP : f32 = 1.0;',
                      'const TERRAIN_LACUNARITY : f32 = 2.0;',
                      'const TERRAIN_PERSISTENCE : f32 = 0.5;',
                      'const TERRAIN_GLOBAL_AMP : f32 = 0.0;',
                      'const TERRAIN_DETAIL_OCTAVES : i32 = 0;',
                      'const TERRAIN_DETAIL_RANGE : f32 = 60.0;',
                      // No craters either: empty class list -> TERRAIN_CRATER_CLASSES = 0 (loops skip).
                      craterHeaderWgsl({ ...DEFAULT_CRATERS, rayClasses: 0, classes: [] }),
                      '@group(0) @binding(21) var<storage, read> terrainPerm : array<u32>;'
                  ].join('\n');

            this.evalPerm = mk(256 * 4, STORAGE | WRITE, 'terrain_topo_evalperm');
            const permU32 = new Uint32Array(256);
            if (n) {
                const perm = buildPerm(n.seed);
                for (let i = 0; i < 256; i++) permU32[i] = perm[i];
            }
            this.evalPerm.update(permU32);

            this.evalLeb = new ComputeShader(
                'terrain_topo_eval_leb_f64',
                engine,
                {
                    computeSource: compose(
                        noiseHeader,
                        terrainNoiseWgsl,
                        terrainU64Wgsl,
                        terrainF64Wgsl,
                        terrainNoiseDf64Wgsl,
                        terrainTopoCommonWgsl,
                        terrainTopoEvalLebF64Wgsl
                    )
                },
                {
                    bindingsMapping: {
                        heapID: { group: 0, binding: 2 },
                        ep: { group: 0, binding: 17 },
                        positions: { group: 0, binding: 19 },
                        terrainPerm: { group: 0, binding: 21 }
                    }
                }
            );
            this.evalLeb.onError = onErr('evalLeb(f64)');
            this.evalLeb.setStorageBuffer('heapID', this.heapID);
            this.evalLeb.setStorageBuffer('positions', this.positions);
            this.evalLeb.setStorageBuffer('terrainPerm', this.evalPerm);
            // Reuse the metric classify camera UBO (camRadius.xyz=camLocal, .w=radius).
            this.evalLeb.setUniformBuffer('ep', this.classifyParams!);

            // --- Active-list EvalLeb (indirect + metric): O(alive) dispatch pair.
            // evalLebActive covers the prev-frame active list; evalLebDelta covers newly-
            // allocated slots absent from that list. Both shaders use identical LEB decode
            // + noise chains; the difference is how the slot id is sourced.
            if (useIndirect) {
                this.evalLebActive = new ComputeShader(
                    'terrain_topo_eval_leb_f64_active', engine,
                    {
                        computeSource: compose(
                            noiseHeader, terrainNoiseWgsl, terrainU64Wgsl,
                            terrainF64Wgsl, terrainNoiseDf64Wgsl,
                            terrainTopoCommonWgsl, terrainTopoEvalLebF64ActiveWgsl
                        )
                    },
                    {
                        bindingsMapping: {
                            heapID: { group: 0, binding: 2 },
                            ep: { group: 0, binding: 17 },
                            positions: { group: 0, binding: 19 },
                            terrainPerm: { group: 0, binding: 21 },
                            activeSlots: { group: 0, binding: 22 },
                            activeCount: { group: 0, binding: 23 }
                        }
                    }
                );
                this.evalLebActive.onError = onErr('evalLebActive(f64)');
                this.evalLebActive.setStorageBuffer('heapID', this.heapID);
                this.evalLebActive.setStorageBuffer('positions', this.positions);
                this.evalLebActive.setStorageBuffer('terrainPerm', this.evalPerm);
                this.evalLebActive.setUniformBuffer('ep', this.classifyParams!);
                this.evalLebActive.setStorageBuffer('activeSlots', this.bisectorIndices!);
                this.evalLebActive.setStorageBuffer('activeCount', this.drawCount!);

                this.evalLebDelta = new ComputeShader(
                    'terrain_topo_eval_leb_f64_delta', engine,
                    {
                        computeSource: compose(
                            noiseHeader, terrainNoiseWgsl, terrainU64Wgsl,
                            terrainF64Wgsl, terrainNoiseDf64Wgsl,
                            terrainTopoCommonWgsl, terrainTopoEvalLebF64DeltaWgsl
                        )
                    },
                    {
                        bindingsMapping: {
                            heapID: { group: 0, binding: 2 },
                            allocate: { group: 0, binding: 8 },
                            ep: { group: 0, binding: 17 },
                            positions: { group: 0, binding: 19 },
                            terrainPerm: { group: 0, binding: 21 }
                        }
                    }
                );
                this.evalLebDelta.onError = onErr('evalLebDelta(f64)');
                this.evalLebDelta.setStorageBuffer('heapID', this.heapID);
                this.evalLebDelta.setStorageBuffer('allocate', this.allocateBuf);
                this.evalLebDelta.setStorageBuffer('positions', this.positions);
                this.evalLebDelta.setStorageBuffer('terrainPerm', this.evalPerm);
                this.evalLebDelta.setUniformBuffer('ep', this.classifyParams!);
            }
        } else {
            this.evalLeb = new ComputeShader(
                'terrain_topo_eval_leb',
                engine,
                { computeSource: compose(terrainU64Wgsl, terrainEvalLebWgsl, terrainTopoCommonWgsl, terrainTopoEvalLebWgsl) },
                {
                    bindingsMapping: {
                        heapID: { group: 0, binding: 2 },
                        positions: { group: 0, binding: 19 }
                    }
                }
            );
            this.evalLeb.onError = onErr('evalLeb');
            this.evalLeb.setStorageBuffer('heapID', this.heapID);
            this.evalLeb.setStorageBuffer('positions', this.positions);
        }

        // --- draw compaction (metric only): live slots -> contiguous index list so the
        // render draws liveCount instances instead of CAPACITY. ---
        if (classifyMode === 'metric') {
            this.compact = new ComputeShader(
                'terrain_topo_compact',
                engine,
                { computeSource: compose(terrainU64Wgsl, terrainTopoCommonWgsl, terrainTopoCompactWgsl) },
                {
                    bindingsMapping: {
                        heapID: { group: 0, binding: 2 },
                        indices: { group: 0, binding: 13 },
                        drawCount: { group: 0, binding: 21 }
                    }
                }
            );
            this.compact.onError = onErr('compact');
            this.compact.setStorageBuffer('heapID', this.heapID);
            this.compact.setStorageBuffer('indices', this.bisectorIndices!);
            this.compact.setStorageBuffer('drawCount', this.drawCount!);

            // GPU zero of drawCount: runs WITHIN the command buffer, AFTER classifyActive
            // has read the previous frame's count, and BEFORE compact's atomicAdd sequence.
            // Replaces the CPU-side drawCount.update(0) (queue.writeBuffer) which was
            // submitted before the command buffer and caused classifyActive to see 0.
            this.resetDrawCount = new ComputeShader(
                'terrain_topo_reset_drawcount', engine,
                { computeSource: compose(terrainTopoResetDrawCountWgsl) },
                { bindingsMapping: { drawCount: { group: 0, binding: 21 } } }
            );
            this.resetDrawCount.onError = onErr('resetDrawCount');
            this.resetDrawCount.setStorageBuffer('drawCount', this.drawCount!);
        }

        // --- indirect dispatch (optional): scale the 7 work-list passes' workgroup
        // count with their candidate counts instead of the full pool capacity. ---
        if (useIndirect) {
            this.indirectArgs = mk(ARG_RECORDS * 16, STORAGE | INDIRECT | WRITE, 'terrain_topo_indirect_args');
            // Seed valid (1,1,1) records so any dispatchIndirect before the first
            // PrepareIndirect is harmless (consumer guards on the in-shader count).
            const seed = new Uint32Array(ARG_RECORDS * 4);
            for (let r = 0; r < ARG_RECORDS; r++) seed[r * 4] = 1;
            this.indirectArgs.update(seed);
            this.prepareIndirect = new ComputeShader(
                'terrain_topo_prepare_indirect',
                engine,
                { computeSource: compose(terrainTopoPrepareIndirectWgsl) },
                {
                    bindingsMapping: {
                        classification: { group: 0, binding: 6 },
                        simplification: { group: 0, binding: 7 },
                        allocate: { group: 0, binding: 8 },
                        propagate: { group: 0, binding: 9 },
                        args: { group: 0, binding: 11 },
                        // binding 21 (drawCount) only wired when in metric mode (drawCount != null)
                        ...(this.drawCount ? { drawCount: { group: 0, binding: 21 } } : {})
                    }
                }
            );
            this.prepareIndirect.onError = onErr('prepareIndirect');
            this.prepareIndirect.setStorageBuffer('classification', this.classification);
            this.prepareIndirect.setStorageBuffer('simplification', this.simplification);
            this.prepareIndirect.setStorageBuffer('allocate', this.allocateBuf);
            this.prepareIndirect.setStorageBuffer('propagate', this.propagate);
            this.prepareIndirect.setStorageBuffer('args', this.indirectArgs);
            if (this.drawCount) {
                this.prepareIndirect.setStorageBuffer('drawCount', this.drawCount);
            }

            // Active-list Classify and CopyNeighbors (metric + indirect only).
            // Both use bisectorIndices (binding 13) and drawCount (binding 21) from compact.
            // classifyActive replaces the O(capacity) metric classify; copyActive replaces
            // the O(3*capacity) word-level neighbor ping-pong.
            if (this.bisectorIndices && this.drawCount) {
                this.classifyActive = new ComputeShader(
                        'terrain_topo_classify_metric_active', engine,
                        {
                            computeSource: compose(
                                terrainU64Wgsl,
                                terrainTopoCommonWgsl,
                                terrainTopoClassifyMetricActiveWgsl
                            )
                        },
                        {
                            bindingsMapping: {
                                heapID:        { group: 0, binding: 2 },
                                bisectorData:  { group: 0, binding: 5 },
                                classification:{ group: 0, binding: 6 },
                                activeSlots:   { group: 0, binding: 13 },
                                cp:            { group: 0, binding: 17 },
                                positions:     { group: 0, binding: 19 },
                                fp:            { group: 0, binding: 20 },
                                activeCount:   { group: 0, binding: 21 }
                            }
                        }
                    );
                this.classifyActive!.onError = onErr('classifyActive(metric)');
                this.classifyActive!.setStorageBuffer('heapID', this.heapID);
                this.classifyActive!.setStorageBuffer('bisectorData', this.bisectorData);
                this.classifyActive!.setStorageBuffer('classification', this.classification);
                this.classifyActive!.setStorageBuffer('activeSlots', this.bisectorIndices);
                this.classifyActive!.setStorageBuffer('positions', this.positions);
                this.classifyActive!.setStorageBuffer('activeCount', this.drawCount);
                this.classifyActive!.setUniformBuffer('cp', this.classifyParams!);
                this.classifyActive!.setUniformBuffer('fp', this.frustumParams!);

                this.copyActive = new ComputeShader(
                        'terrain_topo_copy_neighbors_active', engine,
                        {
                            computeSource: compose(
                                terrainU64Wgsl,
                                terrainTopoCommonWgsl,
                                terrainTopoCopyNeighborsActiveWgsl
                            )
                        },
                        {
                            bindingsMapping: {
                                nbIn:        { group: 0, binding: 3 },
                                nbOut:       { group: 0, binding: 4 },
                                activeSlots: { group: 0, binding: 13 },
                                activeCount: { group: 0, binding: 21 }
                            }
                        }
                    );
                this.copyActive!.onError = onErr('copyActive');
                this.copyActive!.setStorageBuffer('activeSlots', this.bisectorIndices);
                this.copyActive!.setStorageBuffer('activeCount', this.drawCount);
            }

            // One-thread shader that writes ARG.EVAL_LEB from the current drawCount
            // after each compact, so the next frame's evalLebActive dispatches O(active).
            if (this.drawCount) {
                this.prepareEvalLeb = new ComputeShader(
                    'terrain_topo_prepare_eval_leb', engine,
                    { computeSource: compose(terrainTopoPrepareEvalLebWgsl) },
                    {
                        bindingsMapping: {
                            args: { group: 0, binding: 11 },
                            drawCount: { group: 0, binding: 21 }
                        }
                    }
                );
                this.prepareEvalLeb.onError = onErr('prepareEvalLeb');
                this.prepareEvalLeb.setStorageBuffer('args', this.indirectArgs);
                this.prepareEvalLeb.setStorageBuffer('drawCount', this.drawCount);
            }
        }

        // One UBO per reduce level (0..depth). Reusing one UBO across same-submit
        // dispatches coalesces to the last value, so each level needs its own.
        for (let level = 0; level <= this.depth; level++) {
            const ubo = new UniformBuffer(engine, undefined, undefined, `terrain_topo_reduce_lvl_${level}`);
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
            this.propagateBisect,
            this.prepareSimplify,
            this.simplify,
            this.propagateSimplify,
            this.evalLeb,
            ...(this.compact ? [this.compact] : []),
            ...(this.prepareIndirect ? [this.prepareIndirect] : []),
            ...(this.evalLebActive ? [this.evalLebActive] : []),
            ...(this.evalLebDelta ? [this.evalLebDelta] : []),
            ...(this.prepareEvalLeb ? [this.prepareEvalLeb] : []),
            ...(this.classifyActive ? [this.classifyActive] : []),
            ...(this.copyActive ? [this.copyActive] : []),
            ...(this.resetDrawCount ? [this.resetDrawCount] : [])
        ];
        const end = performance.now() + timeoutMs;
        while (!shaders.every((s) => s.isReady())) {
            if (performance.now() > end) {
                throw new Error('TerrainTopologyKernel compute shaders not ready (timeout)');
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
        if (levels.length !== TERRAIN_FACE_COUNT) {
            throw new Error(`TerrainTopologyKernel.setFaceDepths needs ${TERRAIN_FACE_COUNT} levels`);
        }
        this.faceTargets.update(new Uint32Array(levels.map((l) => l >>> 0)));
    }

    /** Set the camera + thresholds for the metric classify (metric mode only). */
    setCameraParams(p: TerrainCameraParams): void {
        if (!this.classifyParams) {
            throw new Error('TerrainTopologyKernel.setCameraParams requires classifyMode "metric"');
        }
        this.classifyParams.updateFloat4('camRadius', p.camLocal[0], p.camLocal[1], p.camLocal[2], p.radius);
        this.classifyParams.updateFloat4('thresh', p.focalPx, p.splitThresholdPx, p.mergeThresholdPx, p.cullMinDot);
        // limits.z = DF64_NEAR_KM: the eval (which shares this UBO as `ep`) reads it as the df64->f32
        // cutoff. The metric classify ignores limits.z (it only uses x = maxLevel, y = minLevel).
        this.classifyParams.updateFloat4('limits', p.maxLevel, p.minLevel, p.df64NearKm, 0);
        this.classifyParams.update();
    }

    /**
     * Set the camera frustum for the metric classify (metric mode only). `planes` is 24
     * floats = 6 × (nx, ny, nz, d) in CAMERA-RELATIVE PLANET-LOCAL space (inward normals);
     * the caller rotates each render-space normal by R^T and keeps d. `guardScale` widens
     * the cull by that many leaf-edges (anti-pop). `enabled = false` disables the test.
     */
    setFrustum(planes: Float32Array, guardScale: number, enabled: boolean, heightMargin = 0): void {
        if (!this.frustumParams) {
            throw new Error('TerrainTopologyKernel.setFrustum requires classifyMode "metric"');
        }
        // ctrl = (enabled, guardScale, heightMargin, _). heightMargin (= max radial vertex
        // displacement) widens the cull so tall relief near the camera is not wrongly culled.
        this.frustumParams.updateUniformArray('planes', planes, 24);
        this.frustumParams.updateFloat4('ctrl', enabled ? 1 : 0, guardScale, heightMargin, 0);
        this.frustumParams.update();
    }

    /** Dispatch Classify — O(active) after first compact, O(capacity) otherwise. */
    private runClassify(full: [number, number]): void {
        if (this.hasCompacted && this.indirectArgs && this.classifyActive) {
            this.classifyActive.dispatchIndirect(this.indirectArgs, ARG.CLASSIFY);
        } else {
            this.classify.dispatch(full[0], full[1], 1);
        }
    }

    /** Dispatch CopyNeighbors — O(active) after first compact, O(capacity) otherwise. */
    private runCopyNeighbors(nbWords: [number, number]): void {
        if (this.hasCompacted && this.indirectArgs && this.copyActive) {
            this.copyActive.dispatchIndirect(this.indirectArgs, ARG.COPY_NB);
        } else {
            this.copy.dispatch(nbWords[0], nbWords[1], 1);
        }
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
        this.copyActive?.setStorageBuffer('nbIn', current);
        this.copyActive?.setStorageBuffer('nbOut', next);
        // PropagateBisect runs AFTER the conceptual swap -> operates on `next`.
        this.propagateBisect.setStorageBuffer('neighbors', next);

        const full = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        const nbWords = grid2D(Math.ceil((this.capacity * NEIGHBORS_WORDS) / WORKGROUP_SIZE));

        this.reset.dispatch(1, 1, 1);
        this.runClassify(full);
        if (this.useIndirect && this.prepareIndirect && this.indirectArgs) {
            // Work-list passes dispatch over their candidate counts (PrepareIndirect
            // rebuilds the args after each producer finalizes its count).
            this.prepareIndirect.dispatch(1, 1, 1); // split rec <- classification[SPLIT_COUNTER]
            this.split.dispatchIndirect(this.indirectArgs, ARG.SPLIT);
            this.prepareIndirect.dispatch(1, 1, 1); // allocate+bisect recs <- allocate[0]
            this.allocate.dispatchIndirect(this.indirectArgs, ARG.ALLOCATE);
            this.runCopyNeighbors(nbWords);
            this.bisect.dispatchIndirect(this.indirectArgs, ARG.BISECT);
            this.prepareIndirect.dispatch(1, 1, 1); // propagate rec <- propagate[0]
            this.propagateBisect.dispatchIndirect(this.indirectArgs, ARG.PROPAGATE_BISECT);
        } else {
            this.split.dispatch(full[0], full[1], 1);
            this.allocate.dispatch(full[0], full[1], 1);
            this.copy.dispatch(nbWords[0], nbWords[1], 1);
            this.bisect.dispatch(full[0], full[1], 1);
            this.propagateBisect.dispatch(full[0], full[1], 1);
        }

        // Rebuild the tree from the bits Bisect set, ready for next frame's Allocate.
        this.runReduce();

        this.liveNeighbors = next;
        this.parity ^= 1;
    }

    /**
     * One coarsening frame (the merge / simplification half). Unlike the split half,
     * the collapse rewires neighbors IN PLACE on the live buffer (PrepareSimplify
     * guarantees disjoint conformant diamonds), so there is no ping-pong. Drives:
     * Reset -> Classify (emits simplify candidates) -> PrepareSimplify -> Simplify
     * (frees slots) -> PropagateSimplify -> pool reduce.
     */
    runMergeFrame(): void {
        const live = this.liveNeighbors; // Classify needs no neighbor buffer
        this.prepareSimplify.setStorageBuffer('neighbors', live);
        this.simplify.setStorageBuffer('neighbors', live);
        this.propagateSimplify.setStorageBuffer('neighbors', live);

        const full = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        this.reset.dispatch(1, 1, 1);
        this.runClassify(full);
        if (this.useIndirect && this.prepareIndirect && this.indirectArgs) {
            this.prepareIndirect.dispatch(1, 1, 1); // prepareSimplify rec <- classification[SIMPLIFY_COUNTER]
            this.prepareSimplify.dispatchIndirect(this.indirectArgs, ARG.PREPARE_SIMPLIFY);
            this.prepareIndirect.dispatch(1, 1, 1); // simplify rec <- simplification[0]
            this.simplify.dispatchIndirect(this.indirectArgs, ARG.SIMPLIFY);
            this.prepareIndirect.dispatch(1, 1, 1); // propagateSimplify rec <- propagate[1]
            this.propagateSimplify.dispatchIndirect(this.indirectArgs, ARG.PROPAGATE_SIMPLIFY);
        } else {
            this.prepareSimplify.dispatch(full[0], full[1], 1);
            this.simplify.dispatch(full[0], full[1], 1);
            this.propagateSimplify.dispatch(full[0], full[1], 1);
        }
        this.runReduce();
    }

    /** The per-slot heap id buffer (flat u32, 2/slot). Render path reads it to gate dead slots. */
    get heapBuffer(): StorageBuffer {
        return this.heapID;
    }

    /** The EvaluateLEB output buffer (f32, 9/slot: 3 unit-dir corners). Render path reads it. */
    get positionsBuffer(): StorageBuffer {
        return this.positions;
    }

    /** Compacted live-slot index list (metric mode). Render: slot = indices[instanceIndex]. */
    get indicesBuffer(): StorageBuffer {
        if (!this.bisectorIndices) throw new Error('indicesBuffer requires classifyMode "metric"');
        return this.bisectorIndices;
    }

    /** Compact the live slots into the contiguous index list (metric mode only). */
    runCompact(): void {
        if (!this.compact || !this.drawCount) return;
        // Zero drawCount INSIDE the command buffer so classifyActive (dispatched earlier in
        // the same buffer) sees the PREVIOUS frame's count rather than 0.
        // A CPU queue.writeBuffer(0) would arrive before the buffer, causing classifyActive
        // to exit early (i >= 0 always true), producing 0 split candidates.
        this.resetDrawCount?.dispatch(1, 1, 1);
        const full = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        this.compact.dispatch(full[0], full[1], 1);
        // Write ARG.EVAL_LEB from the just-built drawCount so the NEXT frame's
        // evalLebActive dispatches O(alive) instead of O(capacity).
        this.prepareEvalLeb?.dispatch(1, 1, 1);
        // Also write ARG.CLASSIFY (8) and ARG.COPY_NB (9) from the same drawCount so the
        // NEXT frame's classify and copyNeighbors active-list dispatches are O(alive).
        // prepareIndirect reads classification[]/allocate[]/etc. too but those values are
        // stale at this point; records 0-7 will be re-written at the START of the next
        // runFrame/runMergeFrame before they are consumed — only 8+9 matter here.
        if (this.classifyActive && this.copyActive) {
            this.prepareIndirect?.dispatch(1, 1, 1);
        }
        this.hasCompacted = true;
    }

    /** Decode every live slot's heap id to 3 unit-dir corners into the positions buffer. */
    runEvalLeb(): void {
        if (
            this.useIndirect &&
            this.indirectArgs &&
            this.evalLebActive &&
            this.hasCompacted
        ) {
            // Active list: compact ran immediately before this call (see terrain_source.ts),
            // so bisectorIndices is the CURRENT frame's live set — no stale-list gap, no delta needed.
            this.evalLebActive.dispatchIndirect(this.indirectArgs, ARG.EVAL_LEB);
        } else {
            // Bootstrap (first frame before compact runs) or predicate mode: O(capacity).
            const full = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
            this.evalLeb.dispatch(full[0], full[1], 1);
        }
    }

    /**
     * Per-bucket GPU compute time for the perf HUD (ms, last-second average). Each pass exposes a
     * `gpuTimeInFrame` counter automatically when the engine has the `timestamp-query` feature and
     * `enableGPUTimingMeasurements = true` (both armed in EngineManager); 0 when unavailable. Buckets:
     * `topoMs` = split/merge topology + pool reduce, `evalMs` = EvaluateLEB (df64 noise — the dominant
     * cost), `compactMs` = draw compaction.
     */
    getGpuTimings(): { topoMs: number; evalMs: number; compactMs: number } {
        // lastSecAverage is NaN when a pass took no GPU samples in the last second (still camera →
        // the re-bake gate skipped all dispatches): guard it so the HUD reads 0.00, not NaN.
        const ms = (cs: ComputeShader | null): number => {
            const ns = cs?.gpuTimeInFrame?.counter.lastSecAverage ?? 0;
            return Number.isFinite(ns) ? ns / 1e6 : 0;
        };
        // classify and copy run their O(active) variant after first compact;
        // both shaders report timing independently — sum whichever ran.
        const classifyMs = this.hasCompacted
            ? ms(this.classifyActive)
            : ms(this.classify);
        const copyMs = this.hasCompacted
            ? ms(this.copyActive)
            : ms(this.copy);
        const topoMs =
            ms(this.reset) + classifyMs + ms(this.split) + ms(this.allocate) +
            copyMs + ms(this.bisect) + ms(this.propagateBisect) +
            ms(this.prepareSimplify) + ms(this.simplify) + ms(this.propagateSimplify) +
            ms(this.reduce) + ms(this.prepareIndirect);
        const evalMs = this.hasCompacted ? ms(this.evalLebActive) : ms(this.evalLeb);
        return { topoMs, evalMs, compactMs: ms(this.compact) };
    }

    /** Read the positions buffer back (capacity * 9 f32: c0.xyz,c1.xyz,c2.xyz per slot). */
    async readPositions(): Promise<Float32Array> {
        const bytes = (await this.positions.read(0, undefined, undefined, true)) as Uint8Array;
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    }

    /** Cheap live-slot count readback (pool_tree[1]) for HUD telemetry. */
    async readCount(): Promise<number> {
        const treeBytes = (await this.poolTree.read(0, 16, undefined, true)) as Uint8Array;
        const tu = new Uint32Array(treeBytes.buffer, treeBytes.byteOffset, treeBytes.byteLength >> 2);
        return tu[1];
    }

    /** Read the live topology back to the CPU for the cross-check (forced flush). */
    async readState(): Promise<TerrainGpuState> {
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
    static readonly INVALID = TERRAIN_INVALID;

    dispose(): void {
        for (const ubo of this.levelParams) ubo.dispose();
        this.levelParams.length = 0;
        this.classifyParams?.dispose();
        this.frustumParams?.dispose();
        this.evalPerm?.dispose();
        this.bisectorIndices?.dispose();
        this.drawCount?.dispose();
        this.indirectArgs?.dispose();
        this.poolBitfield.dispose();
        this.poolTree.dispose();
        this.heapID.dispose();
        this.nbA.dispose();
        this.nbB.dispose();
        this.bisectorData.dispose();
        this.classification.dispose();
        this.simplification.dispose();
        this.allocateBuf.dispose();
        this.propagate.dispose();
        this.memory.dispose();
        this.faceTargets.dispose();
        this.positions.dispose();
    }
}
