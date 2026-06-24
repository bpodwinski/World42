/**
 * OCBT concurrent-engine buffer layout — single source of truth for EVERY storage
 * buffer the GPU concurrent bisector engine needs (the GPU twin of the sequential
 * CPU oracle `ocbt_topology.ts`). Pure sizing + binding indices + seed data, no
 * Babylon import, so the whole layout is unit-testable in Node and the WGSL, the
 * kernel (which creates the real `StorageBuffer`s) and the CPU mirror cross-check all
 * agree on capacity/strides.
 *
 * Element addressing: every per-bisector buffer is indexed by POOL SLOT in
 * [0, CAPACITY). This is the OCBT pool model (cost decoupled from subdivision depth) —
 * the reference's `totalNumElements` maps to World42's pool `capacity`. The pool
 * bitfield + sum-tree (binding 0/1, reused from `ocbt_buffers.ts`) tell the engine
 * which slots are live and feed `pool_decodeBitComplement` for allocation.
 *
 * Neighbor convention map (reference uint3 (n0,n1,n2)  <->  World42 [BASE,LEFT,RIGHT]):
 *   reference n2 = "twin"  (split-edge / hypotenuse)  -> World42 BASE  (index 0)
 *   reference n0 = "Next"  (a leg)                     -> World42 LEFT  (index 1)
 *   reference n1 = "Prev"  (other leg)                 -> World42 RIGHT (index 2)
 * The engine WGSL stores neighbors in the REFERENCE order (n0,n1,n2) per vec3<u32>
 * because the ported Split/Bisect/Propagate logic indexes n[0]/n[1]/n[2] directly;
 * the seed packer below remaps World42 ROOT_NEIGHBORS [BASE,LEFT,RIGHT] into that
 * (n0=LEFT, n1=RIGHT, n2=BASE) order so the two representations stay bit-identical.
 *
 * BisectorData packing (one u32 each unless noted; matches reference `BisectorData`):
 *   subdivisionPattern (u32), indices[3] (3x u32), problematicNeighbor (u32),
 *   bisectorState (i32, stored as u32 bits), flags (u32), propagationID (u32)
 *   = 8 u32 = 32 bytes/slot. Stored as a flat array<u32> view (stride 8) rather than
 *   a WGSL struct array, so there is no std430 struct padding to reason about.
 */
import {
    OCBT_DEFAULT_CAPACITY,
    assertPowerOfTwo,
    bitfieldWordCount
} from './ocbt_pool';

const BYTES_PER_U32 = 4;

// --- sentinels / enums (mirror bisector.hlsl + ocbt_topology.ts) ----------------

/** No neighbor / no index. Reference INVALID_POINTER = 0xFFFFFFFF. */
export const OCBT_INVALID = 0xffffffff >>> 0;

/** subdivisionPattern bits (reference update_utilities.hlsl). */
export const NO_SPLIT = 0x00;
export const CENTER_SPLIT = 0x01;
export const RIGHT_SPLIT = 0x02;
export const LEFT_SPLIT = 0x04;
export const RIGHT_DOUBLE_SPLIT = CENTER_SPLIT | RIGHT_SPLIT; // 0x03
export const LEFT_DOUBLE_SPLIT = CENTER_SPLIT | LEFT_SPLIT; // 0x05
export const TRIPLE_SPLIT = CENTER_SPLIT | RIGHT_SPLIT | LEFT_SPLIT; // 0x07

/** bisectorState (reference). Stored as u32 bits of the i32 value. */
export const BACK_FACE_CULLED = -3;
export const FRUSTUM_CULLED = -2;
export const TOO_SMALL = -1;
export const UNCHANGED_ELEMENT = 0;
export const BISECT_ELEMENT = 1;
export const SIMPLIFY_ELEMENT = 2;
export const MERGED_ELEMENT = 3;

/** flags (reference). */
export const VISIBLE_BISECTOR = 0x1;
export const MODIFIED_BISECTOR = 0x2;

// Neighbor edge order WITHIN a stored vec3<u32> (reference n0,n1,n2 order).
export const N0 = 0; // World42 LEFT
export const N1 = 1; // World42 RIGHT
export const N2 = 2; // World42 BASE (twin / hypotenuse)

// World42 mirror edge indices (ocbt_topology.ts).
export const W42_BASE = 0;
export const W42_LEFT = 1;
export const W42_RIGHT = 2;

// --- binding plan (group 0) -----------------------------------------------------
// 0/1 reused from ocbt_buffers.ts (pool bitfield + sum-tree). The engine buffers
// continue from 2. Each pass binds the SUBSET it touches (Babylon strips unbound
// slots via reflection, so a pass declares only what it reads/writes).

export const BINDING = {
    POOL_BITFIELD: 0, // array<atomic<u32>>  (ocbt_buffers)
    POOL_TREE: 1, // array<u32>          (ocbt_buffers)
    HEAP_ID: 2, // array<u32> flat, 2/slot (u64 lo,hi) — NOT vec2 (avoid std430 stride)
    NEIGHBORS: 3, // array<u32> flat, 3/slot  PING (read this frame)
    NEIGHBORS_OUT: 4, // array<u32> flat, 3/slot  PONG (write this frame)
    BISECTOR_DATA: 5, // array<u32>          (8 u32/slot, flat)
    CLASSIFICATION: 6, // array<atomic<u32>>  (2 + 2*cap)
    SIMPLIFICATION: 7, // array<atomic<u32>>  (1 + cap)
    ALLOCATE: 8, // array<atomic<u32>>  (1 + cap)
    PROPAGATE: 9, // array<atomic<u32>>  (2 + cap)
    MEMORY: 10, // array<atomic<i32>>  (2)
    INDIRECT_DISPATCH: 11, // array<u32>          (9)
    INDIRECT_DRAW: 12, // array<atomic<u32>>  (10)
    BISECTOR_INDICES: 13, // array<u32>          (cap)  compacted live list
    VISIBLE_INDICES: 14, // array<u32>          (cap)
    MODIFIED_INDICES: 15, // array<u32>          (cap)
    VALIDATION: 16, // array<atomic<u32>>  (1) dev-only
    UPDATE_PARAMS: 17, // uniform (camera / thresholds / counts)
    FACE_TARGET: 18, // array<u32> (8) per-face target level (cross-check predicate)
    POSITIONS: 19 // array<f32> (9/slot) EvaluateLEB output: 3 unit-dir corners
} as const;

// --- per-slot strides (u32 words) -----------------------------------------------

// Per-slot buffers are FLAT `array<u32>` (not vec2/vec3) so std430 array stride is
// exactly the word count — `array<vec3<u32>>` would round its stride up to 16 bytes
// (4 u32), wasting a lane and inviting index bugs. WGSL accessors index slot*STRIDE+k.
/** u32 words per heapID slot (u64 lo,hi). */
export const HEAP_ID_WORDS = 2;
/** u32 words per neighbor triple (n0,n1,n2), flat. */
export const NEIGHBORS_WORDS = 3;
/** u32 words per BisectorData slot: pattern + 3 indices + problematic + state + flags + propID. */
export const BISECTOR_DATA_WORDS = 8;
/** f32 words per positions slot: 3 corners * (x,y,z). EvaluateLEB output. */
export const POSITIONS_WORDS = 9;

// Field offsets within a BisectorData slot (u32 index relative to slot*8).
export const BD_PATTERN = 0;
export const BD_INDEX0 = 1;
export const BD_INDEX1 = 2;
export const BD_INDEX2 = 3;
export const BD_PROBLEMATIC = 4;
export const BD_STATE = 5;
export const BD_FLAGS = 6;
export const BD_PROPAGATION = 7;

// Fixed header sizes (in u32) of the variable work buffers (reference layout).
export const CLASSIFY_HEADER = 2; // [0]=SPLIT_COUNTER, [1]=SIMPLIFY_COUNTER
export const SIMPLIFY_HEADER = 1; // [0]=count
export const ALLOCATE_HEADER = 1; // [0]=count
export const PROPAGATE_HEADER = 2; // [0]=splitCount, [1]=simplifyCount
export const MEMORY_WORDS = 2; // [0]=allocCursor, [1]=remainingFreeSlots
export const INDIRECT_DISPATCH_WORDS = 9; // 3 indirect-dispatch arg triples
export const INDIRECT_DRAW_WORDS = 10; // 2 draw-arg quads (4*2) + 2 spares
export const VALIDATION_WORDS = 1;

// --- sizing API (pure, Node-testable) -------------------------------------------

export interface EngineBufferLayout {
    readonly capacity: number;
    readonly depth: number;
    // pool (reused)
    readonly bitfieldBytes: number;
    readonly treeBytes: number;
    // per-slot engine buffers
    readonly heapIdBytes: number;
    readonly neighborsBytes: number; // ONE ping/pong buffer
    readonly bisectorDataBytes: number;
    // work buffers
    readonly classificationBytes: number;
    readonly simplificationBytes: number;
    readonly allocateBytes: number;
    readonly propagateBytes: number;
    readonly memoryBytes: number;
    // indexation / indirect
    readonly indirectDispatchBytes: number;
    readonly indirectDrawBytes: number;
    readonly bisectorIndicesBytes: number; // each of the 3 compacted lists
    readonly validationBytes: number;
    /** Total GPU storage footprint (both neighbor buffers + 3 index lists counted). */
    readonly totalBytes: number;
}

function bytes(words: number): number {
    return words * BYTES_PER_U32;
}

export function heapIdWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    return capacity * HEAP_ID_WORDS;
}
export function neighborsWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    return capacity * NEIGHBORS_WORDS;
}
export function bisectorDataWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    return capacity * BISECTOR_DATA_WORDS;
}
export function classificationWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    // 2 counters + a split list (<=cap) + a simplify list (<=cap), reference layout.
    return CLASSIFY_HEADER + 2 * capacity;
}
export function simplificationWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    return SIMPLIFY_HEADER + capacity;
}
export function allocateWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    return ALLOCATE_HEADER + capacity;
}
export function propagateWords(capacity: number): number {
    assertPowerOfTwo(capacity);
    return PROPAGATE_HEADER + capacity;
}

export function engineLayout(
    capacity: number = OCBT_DEFAULT_CAPACITY
): EngineBufferLayout {
    assertPowerOfTwo(capacity);
    const depth = 31 - Math.clz32(capacity);
    const bitfieldBytes = bytes(bitfieldWordCount(capacity));
    const treeBytes = bytes(2 * capacity);
    const heapIdBytes = bytes(heapIdWords(capacity));
    const neighborsBytes = bytes(neighborsWords(capacity));
    const bisectorDataBytes = bytes(bisectorDataWords(capacity));
    const classificationBytes = bytes(classificationWords(capacity));
    const simplificationBytes = bytes(simplificationWords(capacity));
    const allocateBytes = bytes(allocateWords(capacity));
    const propagateBytes = bytes(propagateWords(capacity));
    const memoryBytes = bytes(MEMORY_WORDS);
    const indirectDispatchBytes = bytes(INDIRECT_DISPATCH_WORDS);
    const indirectDrawBytes = bytes(INDIRECT_DRAW_WORDS);
    const bisectorIndicesBytes = bytes(capacity);
    const validationBytes = bytes(VALIDATION_WORDS);
    const totalBytes =
        bitfieldBytes +
        treeBytes +
        heapIdBytes +
        2 * neighborsBytes + // ping + pong
        bisectorDataBytes +
        classificationBytes +
        simplificationBytes +
        allocateBytes +
        propagateBytes +
        memoryBytes +
        indirectDispatchBytes +
        indirectDrawBytes +
        3 * bisectorIndicesBytes + // bisector / visible / modified
        validationBytes;
    return {
        capacity,
        depth,
        bitfieldBytes,
        treeBytes,
        heapIdBytes,
        neighborsBytes,
        bisectorDataBytes,
        classificationBytes,
        simplificationBytes,
        allocateBytes,
        propagateBytes,
        memoryBytes,
        indirectDispatchBytes,
        indirectDrawBytes,
        bisectorIndicesBytes,
        validationBytes,
        totalBytes
    };
}

// --- octahedron SEED (8 root bisectors, heapIDs 8..15) --------------------------
// [BASE,LEFT,RIGHT] adjacency for a CONSISTENTLY-ORIENTED octahedron (every shared
// edge is traversed in OPPOSITE directions by its two faces — standard manifold
// orientation). This is REQUIRED by the ported reference engine: BisectElement's
// `evaluate_neighbors` assumes a BASE-twin shares the split edge FLIPPED, which only
// holds for consistent orientation. World42's ocbt_topology.ts ROOT_NEIGHBORS (and
// lebFaceCorners) wind the 4 TOP faces opposite to the 4 BOTTOM faces, so vs that
// mirror the top faces (0..3) have LEFT<->RIGHT swapped here; the bottom faces (4..7)
// are identical. The matching consistently-wound face corners (top faces' l<->r
// swapped) live in the GPU eval-leb decoder. The CPU oracle keeps its own convention;
// the cross-check compares geometry, so both still describe the same octahedron.
const ROOT_NEIGHBORS_W42: ReadonlyArray<readonly [number, number, number]> = [
    [4, 1, 3],
    [5, 2, 0],
    [6, 3, 1],
    [7, 0, 2],
    [0, 7, 5],
    [1, 4, 6],
    [2, 5, 7],
    [3, 6, 4]
];

export interface EngineSeed {
    /** heapID buffer prefix: 8 slots * 2 u32 (lo,hi). Roots = 8..15, hi always 0. */
    heapID: Uint32Array;
    /** neighbors buffer prefix: 8 slots * 3 u32 in REFERENCE (n0,n1,n2) order. */
    neighbors: Uint32Array;
    /** bisectorData buffer prefix: 8 slots * 8 u32, zeroed + flags=VISIBLE. */
    bisectorData: Uint32Array;
    /** packed pool bitfield prefix marking slots 0..7 allocated. */
    bitfield: Uint32Array;
    /** number of seeded (live) slots. */
    liveCount: number;
}

/**
 * Build the seed prefixes for the 8 octahedron root bisectors at pool slots 0..7.
 * heapID[i] = 8+i (depth 3). Neighbors are remapped World42 [BASE,LEFT,RIGHT] ->
 * reference (n0=LEFT, n1=RIGHT, n2=BASE). The caller uploads each prefix into the
 * front of its full-capacity buffer (the rest stays zero = free / heapID 0).
 */
export function buildEngineSeed(capacity: number = OCBT_DEFAULT_CAPACITY): EngineSeed {
    assertPowerOfTwo(capacity);
    if (capacity < 8) throw new Error('OCBT capacity must hold the 8 root bisectors');
    const heapID = new Uint32Array(8 * HEAP_ID_WORDS);
    const neighbors = new Uint32Array(8 * NEIGHBORS_WORDS);
    const bisectorData = new Uint32Array(8 * BISECTOR_DATA_WORDS);
    for (let i = 0; i < 8; i++) {
        heapID[i * HEAP_ID_WORDS + 0] = (8 + i) >>> 0; // lo
        heapID[i * HEAP_ID_WORDS + 1] = 0; // hi
        const [base, left, right] = ROOT_NEIGHBORS_W42[i];
        // Reference order: n0=LEFT, n1=RIGHT, n2=BASE(twin).
        neighbors[i * NEIGHBORS_WORDS + N0] = left >>> 0;
        neighbors[i * NEIGHBORS_WORDS + N1] = right >>> 0;
        neighbors[i * NEIGHBORS_WORDS + N2] = base >>> 0;
        // BisectorData: pattern=0, indices=INVALID, problematic=INVALID,
        // state=UNCHANGED(0), flags=VISIBLE, propagationID=INVALID.
        const b = i * BISECTOR_DATA_WORDS;
        bisectorData[b + BD_PATTERN] = NO_SPLIT;
        bisectorData[b + BD_INDEX0] = OCBT_INVALID;
        bisectorData[b + BD_INDEX1] = OCBT_INVALID;
        bisectorData[b + BD_INDEX2] = OCBT_INVALID;
        bisectorData[b + BD_PROBLEMATIC] = OCBT_INVALID;
        bisectorData[b + BD_STATE] = UNCHANGED_ELEMENT >>> 0;
        bisectorData[b + BD_FLAGS] = VISIBLE_BISECTOR;
        bisectorData[b + BD_PROPAGATION] = OCBT_INVALID;
    }
    const bitfield = new Uint32Array(bitfieldWordCount(capacity));
    bitfield[0] = 0xff; // slots 0..7 allocated
    return { heapID, neighbors, bisectorData, bitfield, liveCount: 8 };
}

/**
 * WGSL const preamble for the engine: pool consts + the packed BisectorData stride
 * and the sentinels, so the WGSL and this TS layout cannot drift.
 */
export function engineWgslPreamble(
    capacity: number = OCBT_DEFAULT_CAPACITY
): string {
    assertPowerOfTwo(capacity);
    const depth = 31 - Math.clz32(capacity);
    return (
        `const OCBT_CAPACITY : u32 = ${capacity >>> 0}u;\n` +
        `const OCBT_DEPTH : u32 = ${depth}u;\n` +
        `const OCBT_INVALID : u32 = 4294967295u;\n` +
        `const BISECTOR_DATA_WORDS : u32 = ${BISECTOR_DATA_WORDS}u;\n`
    );
}
