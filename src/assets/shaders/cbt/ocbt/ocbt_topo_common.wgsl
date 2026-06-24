// OCBT concurrent-topology engine — shared pure helpers (NO buffer declarations,
// NO entry point). Each pass file declares its own buffers (with the correct
// atomic-ness per pass — bisectorData is array<atomic<u32>> in Split but plain
// array<u32> elsewhere, which a single shared decl could not express) and appends
// this include for the consts + heap-id math + the deterministic classify predicate.
//
// Composed AFTER: engineWgslPreamble (OCBT_CAPACITY/OCBT_DEPTH/OCBT_INVALID/
// BISECTOR_DATA_WORDS) + ocbt_u64.wgsl (u64 = vec2<u32> helpers). Mirrors the
// reference update_utilities.hlsl constants exactly. No semicolons inside line
// comments (Babylon WGSL preprocessor limitation).

// ---- octahedron base depth: faces are heap nodes 8..15 (depth 3) ----------------
const BASE_DEPTH : u32 = 3u;

// ---- subdivision pattern flags (reference update_utilities.hlsl) -----------------
const NO_SPLIT      : u32 = 0x0u;
const CENTER_SPLIT  : u32 = 0x1u;
const RIGHT_SPLIT   : u32 = 0x2u;
const LEFT_SPLIT    : u32 = 0x4u;
const RIGHT_DOUBLE  : u32 = 0x3u;  // CENTER | RIGHT
const LEFT_DOUBLE   : u32 = 0x5u;  // CENTER | LEFT
const TRIPLE        : u32 = 0x7u;  // CENTER | RIGHT | LEFT

// ---- bisector states (reference) ------------------------------------------------
const ST_UNCHANGED : u32 = 0u;
const ST_BISECT    : u32 = 1u;
const ST_SIMPLIFY  : u32 = 2u;
const ST_MERGED    : u32 = 3u;

// ---- flags (reference) ----------------------------------------------------------
const FLAG_VISIBLE  : u32 = 0x1u;
const FLAG_MODIFIED : u32 = 0x2u;

// ---- classification list header offsets (reference) -----------------------------
const SPLIT_COUNTER           : u32 = 0u;
const SIMPLIFY_COUNTER        : u32 = 1u;
const CLASSIFY_COUNTER_OFFSET : u32 = 2u;

// ---- BisectorData flat field offsets (slot*8 + field) ----------------------------
// Mirror of BD_* in ocbt_engine_buffers.ts.
const BD_PATTERN     : u32 = 0u;
const BD_INDEX0      : u32 = 1u;
const BD_INDEX1      : u32 = 2u;
const BD_INDEX2      : u32 = 3u;
const BD_PROBLEMATIC : u32 = 4u;
const BD_STATE       : u32 = 5u;
const BD_FLAGS       : u32 = 6u;
const BD_PROPAGATION : u32 = 7u;

// Per-slot strides (flat array<u32>).
const NB_WORDS : u32 = 3u;   // neighbors triple (n0=LEFT, n1=RIGHT, n2=TWIN/BASE)
const BD_WORDS : u32 = 8u;   // bisectorData

// 2D workgroup-grid linearization (matches grid2D in the harness): the X dimension
// is capped at 65535 groups and the overflow spills into Y. Reconstruct the linear
// invocation index from the dispatched grid.
fn linear_id(gid : vec3<u32>, num_wg_x : u32) -> u32 {
    return gid.x + gid.y * (num_wg_x * 256u);
}

// ---- heap-id child math (u64) ---------------------------------------------------
fn heap_is_zero(h : vec2<u32>) -> bool { return h.x == 0u && h.y == 0u; }
fn heap_2h(h : vec2<u32>)  -> vec2<u32> { return u64_shl(h, 1u); }
fn heap_2hp1(h : vec2<u32>) -> vec2<u32> { return u64_or(u64_shl(h, 1u), vec2<u32>(1u, 0u)); }
fn heap_4h(h : vec2<u32>)  -> vec2<u32> { return u64_shl(h, 2u); }
fn heap_4hpk(h : vec2<u32>, k : u32) -> vec2<u32> { return u64_or(u64_shl(h, 2u), vec2<u32>(k, 0u)); }

// True iff leaf heap `hL` (depth dL) is a PROPER ancestor of target heap `hT`
// (depth dT) in the bintree, i.e. dL < dT and the top dL bits of hT equal hL.
// This is the deterministic, FP-free refinement predicate the GPU and the CPU
// oracle both evaluate, so their conforming closures converge to the same leaf set.
fn heap_is_ancestor(hL : vec2<u32>, dL : u32, hT : vec2<u32>, dT : u32) -> bool {
    if (dL >= dT) { return false; }
    return u64_eq(u64_shr(hT, dT - dL), hL);
}
