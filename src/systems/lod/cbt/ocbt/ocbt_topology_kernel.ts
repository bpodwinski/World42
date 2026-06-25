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
import ocbtTopoClassifyMetricWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_classify_metric.compute.wgsl';
import ocbtTopoSplitWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_split.compute.wgsl';
import ocbtTopoAllocateWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_allocate.compute.wgsl';
import ocbtTopoCopyNeighborsWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_copy_neighbors.compute.wgsl';
import ocbtTopoBisectWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_bisect.compute.wgsl';
import ocbtTopoPropagateBisectWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_propagate_bisect.compute.wgsl';
import ocbtTopoPrepareSimplifyWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_prepare_simplify.compute.wgsl';
import ocbtTopoSimplifyWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_simplify.compute.wgsl';
import ocbtTopoPropagateSimplifyWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_propagate_simplify.compute.wgsl';
import ocbtPoolReduceWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_pool_reduce.compute.wgsl';
import cbtNoiseWgsl from '../../../../assets/shaders/cbt/gpu/cbt_noise.wgsl';
import { buildPerm, type NoiseParams } from '../cbt_noise';
import ocbtEvalLebWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_eval_leb.wgsl';
import ocbtF64Wgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_f64.wgsl';
import ocbtTopoEvalLebWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_eval_leb.compute.wgsl';
import ocbtTopoEvalLebF64Wgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_eval_leb_f64.compute.wgsl';
import ocbtTopoCompactWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_compact.compute.wgsl';
import ocbtTopoPrepareIndirectWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_prepare_indirect.compute.wgsl';
import {
    engineLayout,
    engineWgslPreamble,
    buildEngineSeed,
    HEAP_ID_WORDS,
    NEIGHBORS_WORDS,
    BISECTOR_DATA_WORDS,
    POSITIONS_WORDS,
    OCBT_INVALID
} from './ocbt_engine_buffers';
import { log2PowerOfTwo } from './ocbt_pool';

const WORKGROUP_SIZE = 256;
const MAX_DIM = 65535;

/** Number of octahedron faces (root bisectors). */
export const OCBT_FACE_COUNT = 8;

/** Classify metric source: deterministic per-face predicate (cross-check) or camera. */
export type OcbtClassifyMode = 'predicate' | 'metric';

/** Camera + threshold inputs for the metric classify (all in planet-local sim units). */
export interface OcbtCameraParams {
    camLocal: [number, number, number];
    radius: number;
    focalPx: number;
    splitThresholdPx: number;
    mergeThresholdPx: number;
    cullMinDot: number;
    maxLevel: number;
}

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
const INDIRECT = Constants.BUFFER_CREATIONFLAG_INDIRECT;

/** Byte offset of each work-list pass's record in the indirect-args buffer (16 B/record). */
const ARG = {
    SPLIT: 0,
    ALLOCATE: 16,
    BISECT: 32,
    PROPAGATE_BISECT: 48,
    PREPARE_SIMPLIFY: 64,
    SIMPLIFY: 80,
    PROPAGATE_SIMPLIFY: 96
} as const;
const ARG_RECORDS = 7;

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
    private readonly drawCountZero = new Uint32Array(1);
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

    /** One UBO per reduce level 0..depth (index `depth` = leaf prepass). */
    private readonly levelParams: UniformBuffer[] = [];

    /** Classify metric source. */
    private readonly classifyMode: OcbtClassifyMode;
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
        classifyMode: OcbtClassifyMode = 'predicate',
        useIndirect = false,
        noise: NoiseParams | null = null
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

        this.poolBitfield = mk(layout.bitfieldBytes, STORAGE | WRITE, 'ocbt_topo_bitfield');
        this.poolTree = mk(layout.treeBytes, STORAGE | READ | WRITE, 'ocbt_topo_tree');
        this.heapID = mk(layout.heapIdBytes, STORAGE | READ | WRITE, 'ocbt_topo_heapid');
        this.nbA = mk(layout.neighborsBytes, STORAGE | READ | WRITE, 'ocbt_topo_nbA');
        this.nbB = mk(layout.neighborsBytes, STORAGE | READ | WRITE, 'ocbt_topo_nbB');
        this.bisectorData = mk(layout.bisectorDataBytes, STORAGE | WRITE, 'ocbt_topo_bisectordata');
        this.classification = mk(layout.classificationBytes, STORAGE | WRITE, 'ocbt_topo_classify');
        this.simplification = mk(layout.simplificationBytes, STORAGE | WRITE, 'ocbt_topo_simplify');
        this.allocateBuf = mk(layout.allocateBytes, STORAGE | WRITE, 'ocbt_topo_allocate');
        this.propagate = mk(layout.propagateBytes, STORAGE | WRITE, 'ocbt_topo_propagate');
        this.memory = mk(layout.memoryBytes, STORAGE | WRITE, 'ocbt_topo_memory');
        this.faceTargets = mk(OCBT_FACE_COUNT * 4, STORAGE | WRITE, 'ocbt_topo_facetargets');
        // Metric (render) mode emits camera-relative [relative.xyz, dir.xyz] (18/slot) via
        // the df64 eval; predicate (cross-check) mode emits unit-dir corners (9/slot).
        const posWords = classifyMode === 'metric' ? 18 : POSITIONS_WORDS;
        this.positionsWords = posWords;
        this.positions = mk(capacity * posWords * 4, STORAGE | READ | WRITE, 'ocbt_topo_positions');
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
                'ocbt_topo_classify_metric',
                engine,
                { computeSource: compose(ocbtU64Wgsl, ocbtTopoCommonWgsl, ocbtTopoClassifyMetricWgsl) },
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
            this.classifyParams = new UniformBuffer(engine, undefined, undefined, 'ocbt_classify_params');
            this.classifyParams.addUniform('camRadius', 4);
            this.classifyParams.addUniform('thresh', 4);
            this.classifyParams.addUniform('limits', 4);
            this.classifyParams.updateFloat4('camRadius', 0, 0, 0, 1);
            this.classifyParams.updateFloat4('thresh', 1, 1e9, 1e9, -1);
            this.classifyParams.updateFloat4('limits', 0, 0, 0, 0);
            this.classifyParams.update();
            // Frustum UBO (camera-relative planet-local planes). Default disabled.
            this.frustumParams = new UniformBuffer(engine, undefined, undefined, 'ocbt_frustum_params');
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
        }

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

        // --- merge half: prepare-simplify / simplify / propagate-simplify ---
        this.prepareSimplify = new ComputeShader(
            'ocbt_topo_prepare_simplify',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtTopoCommonWgsl, ocbtTopoPrepareSimplifyWgsl) },
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
            'ocbt_topo_simplify',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtPoolWgsl, ocbtTopoCommonWgsl, ocbtTopoSimplifyWgsl) },
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
            'ocbt_topo_propagate_simplify',
            engine,
            { computeSource: compose(ocbtU64Wgsl, ocbtTopoCommonWgsl, ocbtTopoPropagateSimplifyWgsl) },
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
            // displaces each corner radially by cbtFbmHeight(dir). So `positions` holds the
            // real terrain surface (not the smooth sphere) and the whole classify — screenPx,
            // frustum, horizon — is terrain-aware. cbt_noise.wgsl needs the baked CBT_* fbm
            // constants + the cbtPerm storage buffer declared BEFORE it.
            const n = noise;
            const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
            const noiseHeader = n
                ? [
                      `const CBT_OCTAVES : i32 = ${Math.max(0, Math.floor(n.octaves))};`,
                      `const CBT_BASE_FREQ : f32 = ${f(n.baseFrequency)};`,
                      `const CBT_BASE_AMP : f32 = ${f(n.baseAmplitude)};`,
                      `const CBT_LACUNARITY : f32 = ${f(n.lacunarity)};`,
                      `const CBT_PERSISTENCE : f32 = ${f(n.persistence)};`,
                      `const CBT_GLOBAL_AMP : f32 = ${f(n.globalAmplitude)};`,
                      `const CBT_DETAIL_OCTAVES : i32 = ${Math.max(0, Math.floor(n.detailOctaves ?? 0))};`,
                      `const CBT_DETAIL_RANGE : f32 = ${f(n.detailRange ?? 60)};`,
                      '@group(0) @binding(21) var<storage, read> cbtPerm : array<u32>;'
                  ].join('\n')
                : [
                      // No noise configured -> zero relief (smooth sphere), still valid WGSL.
                      'const CBT_OCTAVES : i32 = 0;',
                      'const CBT_BASE_FREQ : f32 = 1.0;',
                      'const CBT_BASE_AMP : f32 = 1.0;',
                      'const CBT_LACUNARITY : f32 = 2.0;',
                      'const CBT_PERSISTENCE : f32 = 0.5;',
                      'const CBT_GLOBAL_AMP : f32 = 0.0;',
                      'const CBT_DETAIL_OCTAVES : i32 = 0;',
                      'const CBT_DETAIL_RANGE : f32 = 60.0;',
                      '@group(0) @binding(21) var<storage, read> cbtPerm : array<u32>;'
                  ].join('\n');

            this.evalPerm = mk(256 * 4, STORAGE | WRITE, 'ocbt_topo_evalperm');
            const permU32 = new Uint32Array(256);
            if (n) {
                const perm = buildPerm(n.seed);
                for (let i = 0; i < 256; i++) permU32[i] = perm[i];
            }
            this.evalPerm.update(permU32);

            this.evalLeb = new ComputeShader(
                'ocbt_topo_eval_leb_f64',
                engine,
                {
                    computeSource: compose(
                        noiseHeader,
                        cbtNoiseWgsl,
                        ocbtU64Wgsl,
                        ocbtF64Wgsl,
                        ocbtTopoCommonWgsl,
                        ocbtTopoEvalLebF64Wgsl
                    )
                },
                {
                    bindingsMapping: {
                        heapID: { group: 0, binding: 2 },
                        ep: { group: 0, binding: 17 },
                        positions: { group: 0, binding: 19 },
                        cbtPerm: { group: 0, binding: 21 }
                    }
                }
            );
            this.evalLeb.onError = onErr('evalLeb(f64)');
            this.evalLeb.setStorageBuffer('heapID', this.heapID);
            this.evalLeb.setStorageBuffer('positions', this.positions);
            this.evalLeb.setStorageBuffer('cbtPerm', this.evalPerm);
            // Reuse the metric classify camera UBO (camRadius.xyz=camLocal, .w=radius).
            this.evalLeb.setUniformBuffer('ep', this.classifyParams!);
        } else {
            this.evalLeb = new ComputeShader(
                'ocbt_topo_eval_leb',
                engine,
                { computeSource: compose(ocbtU64Wgsl, ocbtEvalLebWgsl, ocbtTopoCommonWgsl, ocbtTopoEvalLebWgsl) },
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
            this.bisectorIndices = mk(capacity * 4, STORAGE | READ | WRITE, 'ocbt_topo_indices');
            this.drawCount = mk(4, STORAGE | WRITE, 'ocbt_topo_drawcount');
            this.compact = new ComputeShader(
                'ocbt_topo_compact',
                engine,
                { computeSource: compose(ocbtU64Wgsl, ocbtTopoCommonWgsl, ocbtTopoCompactWgsl) },
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
            this.compact.setStorageBuffer('indices', this.bisectorIndices);
            this.compact.setStorageBuffer('drawCount', this.drawCount);
        }

        // --- indirect dispatch (optional): scale the 7 work-list passes' workgroup
        // count with their candidate counts instead of the full pool capacity. ---
        if (useIndirect) {
            this.indirectArgs = mk(ARG_RECORDS * 16, STORAGE | INDIRECT | WRITE, 'ocbt_topo_indirect_args');
            // Seed valid (1,1,1) records so any dispatchIndirect before the first
            // PrepareIndirect is harmless (consumer guards on the in-shader count).
            const seed = new Uint32Array(ARG_RECORDS * 4);
            for (let r = 0; r < ARG_RECORDS; r++) seed[r * 4] = 1;
            this.indirectArgs.update(seed);
            this.prepareIndirect = new ComputeShader(
                'ocbt_topo_prepare_indirect',
                engine,
                { computeSource: compose(ocbtTopoPrepareIndirectWgsl) },
                {
                    bindingsMapping: {
                        classification: { group: 0, binding: 6 },
                        simplification: { group: 0, binding: 7 },
                        allocate: { group: 0, binding: 8 },
                        propagate: { group: 0, binding: 9 },
                        args: { group: 0, binding: 11 }
                    }
                }
            );
            this.prepareIndirect.onError = onErr('prepareIndirect');
            this.prepareIndirect.setStorageBuffer('classification', this.classification);
            this.prepareIndirect.setStorageBuffer('simplification', this.simplification);
            this.prepareIndirect.setStorageBuffer('allocate', this.allocateBuf);
            this.prepareIndirect.setStorageBuffer('propagate', this.propagate);
            this.prepareIndirect.setStorageBuffer('args', this.indirectArgs);
        }

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
            this.propagateBisect,
            this.prepareSimplify,
            this.simplify,
            this.propagateSimplify,
            this.evalLeb,
            ...(this.compact ? [this.compact] : []),
            ...(this.prepareIndirect ? [this.prepareIndirect] : [])
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

    /** Set the camera + thresholds for the metric classify (metric mode only). */
    setCameraParams(p: OcbtCameraParams): void {
        if (!this.classifyParams) {
            throw new Error('OcbtTopologyKernel.setCameraParams requires classifyMode "metric"');
        }
        this.classifyParams.updateFloat4('camRadius', p.camLocal[0], p.camLocal[1], p.camLocal[2], p.radius);
        this.classifyParams.updateFloat4('thresh', p.focalPx, p.splitThresholdPx, p.mergeThresholdPx, p.cullMinDot);
        this.classifyParams.updateFloat4('limits', p.maxLevel, 0, 0, 0);
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
            throw new Error('OcbtTopologyKernel.setFrustum requires classifyMode "metric"');
        }
        // ctrl = (enabled, guardScale, heightMargin, _). heightMargin (= max radial vertex
        // displacement) widens the cull so tall relief near the camera is not wrongly culled.
        this.frustumParams.updateUniformArray('planes', planes, 24);
        this.frustumParams.updateFloat4('ctrl', enabled ? 1 : 0, guardScale, heightMargin, 0);
        this.frustumParams.update();
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
        this.classify.dispatch(full[0], full[1], 1); // builder: stays O(capacity)
        if (this.useIndirect && this.prepareIndirect && this.indirectArgs) {
            // Work-list passes dispatch over their candidate counts (PrepareIndirect
            // rebuilds the args after each producer finalizes its count).
            this.prepareIndirect.dispatch(1, 1, 1); // split rec <- classification[SPLIT_COUNTER]
            this.split.dispatchIndirect(this.indirectArgs, ARG.SPLIT);
            this.prepareIndirect.dispatch(1, 1, 1); // allocate+bisect recs <- allocate[0]
            this.allocate.dispatchIndirect(this.indirectArgs, ARG.ALLOCATE);
            this.copy.dispatch(nbWords[0], nbWords[1], 1); // whole-buffer ping-pong: O(capacity)
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
        this.classify.dispatch(full[0], full[1], 1); // builder: stays O(capacity)
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
        this.drawCount.update(this.drawCountZero); // CPU clear the atomic cursor (4 bytes)
        const full = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        this.compact.dispatch(full[0], full[1], 1);
    }

    /** Decode every live slot's heap id to 3 unit-dir corners into the positions buffer. */
    runEvalLeb(): void {
        const full = grid2D(Math.ceil(this.capacity / WORKGROUP_SIZE));
        this.evalLeb.dispatch(full[0], full[1], 1);
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
