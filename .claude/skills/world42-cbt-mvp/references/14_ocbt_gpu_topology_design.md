# OCBT GPU concurrent topology — design + drafts (workflow wf_fc63b7ba)

## Reconciled buffer table
UNIFIED BUFFER / BINDING TABLE (group 0, one stable map; each pass binds ONLY the subset it touches — Babylon reflection strips the rest, and binding an absent slot invalidates the whole group as already learned in the pool decode pass).

DECISIONS THAT OVERRIDE THE DRAFTS:
- Neighbor storage order = REFERENCE (n0=LEFT, n1=RIGHT, n2=BASE/twin). This matches the ALREADY-COMMITTED ocbt_engine_buffers.ts (BINDING/N0/N1/N2 consts + buildEngineSeed remap). draft:crosscheck's "store in [BASE,LEFT,RIGHT]" is rejected; the lane remap lives only in the TS comparator (ref->oracle). LOCKED.
- Neighbors stored FLAT array<u32>, 4 u32/slot (n0,n1,n2,pad). This resolves the array<vec3<u32>> 16-byte-stride trap (all 4 drafts flag it). NOTE: this changes NEIGHBORS_WORDS in ocbt_engine_buffers.ts from 3 to 4 (with pad) for the GPU buffer; keep a separate PACKED_NEIGHBOR_WORDS=3 only for the seed-prefix CPU array if desired, but the uploaded buffer and all WGSL use stride 4. ACTION: update neighborsWords()/seed to stride 4.
- bisectorData = ONE flat array, declared array<atomic<u32>> in passes that atomicOr the pattern lane (Split/Bisect/Classify) and array<u32> in read-only passes — legal because each pass is a separate compose unit. Field offsets per ocbt_engine_buffers.ts BD_*.
- memory = array<atomic<i32>> (signed; Split over-reserves then refunds). draft:wgsl-engine's "store u32 + atomicSub" is rejected in favor of the committed i32 layout; use atomicAdd with negative i32.
- Per-pass bind groups, NOT one mega 18-binding group. >8 storage buffers/stage exceeds default adapter limits; each pass uses <=8. The BINDING map gives each buffer a STABLE binding NUMBER, but a given pass declares only its subset.

| # | name | WGSL type (per-pass) | binding | size formula (bytes) | flags |
|---|------|----------------------|---------|----------------------|-------|
| 0 | pool_bitfield | array<atomic<u32>> | 0 | ceil(cap/32)*4 | STORAGE\|WRITE |
| 1 | pool_tree | array<u32> | 1 | 2*cap*4 | STORAGE\|READ\|WRITE |
| 2 | heapID | array<u32> (2/slot lo,hi) | 2 | cap*2*4 | STORAGE\|READ\|WRITE |
| 3 | nbCurrent (ping) | array<u32> (4/slot) | 3 | cap*4*4 | STORAGE\|READ\|WRITE |
| 4 | nbNext (pong) | array<u32> (4/slot) | 4 | cap*4*4 | STORAGE\|READ\|WRITE |
| 5 | bisectorData | array<atomic<u32>>/array<u32> (8/slot) | 5 | cap*8*4 | STORAGE\|READ\|WRITE |
| 6 | classification | array<atomic<u32>> | 6 | (2+2*cap)*4 | STORAGE\|WRITE |
| 7 | simplification | array<atomic<u32>> | 7 | (1+cap)*4 | STORAGE\|WRITE |
| 8 | allocate | array<atomic<u32>> | 8 | (1+cap)*4 | STORAGE\|WRITE |
| 9 | propagate | array<atomic<u32>> | 9 | (2+cap)*4 | STORAGE\|WRITE |
| 10 | memory | array<atomic<i32>> | 10 | 2*4 | STORAGE\|WRITE |
| 11 | indirectArgs | array<u32> (gx,gy,1,pad) | 11 | 4*4 | STORAGE\|INDIRECT\|WRITE |
| 12 | liveDispatchArgs | array<u32> (gx,gy,1,pad) | (alias of work pass; separate buffer) | 4*4 | STORAGE\|INDIRECT\|WRITE |
| 13 | bisectorIndices | array<u32> | 13 | cap*4 | STORAGE\|READ |
| 14 | visibleIndices | array<u32> | 14 | cap*4 | STORAGE\|READ |
| 15 | modifiedIndices | array<u32> | 15 | cap*4 | STORAGE\|READ |
| 16 | indirectDraw | array<atomic<u32>> | 16 | 10*4 | STORAGE\|INDIRECT\|WRITE |
| 17 | validation | array<atomic<u32>> | 17 | 4 | STORAGE\|READ\|WRITE (dev-only) |
| 18 | reduceParams/prepParams/frameParams | uniform vec4(+) | 2 or pass-local | per-pass UBO | UNIFORM |

Reconciliation with ocbt_engine_buffers.ts current consts: keep BINDING.* numbers; reassign INDIRECT_DISPATCH/INDIRECT_DRAW to the per-pass-local indirectArgs(11)+indirectDraw(16) scheme (the committed "9 u32 INDIRECT_DISPATCH" single buffer is replaced by reusable 4-u32 indirectArgs written per work pass + a 4-u32 liveDispatchArgs, mirroring cbt_dispatch_args). Per-slot strides: HEAP_ID_WORDS=2, NEIGHBORS_WORDS=4 (was 3 — FIX), BISECTOR_DATA_WORDS=8.

Seed (buildEngineSeed): slots 0..7 heapID=8..15 (hi=0), neighbors remapped to (n0=LEFT,n1=RIGHT,n2=BASE) with stride 4 (pad=0xFFFFFFFF or 0; use OCBT_INVALID), bisectorData defaults (pattern=0,indices=INVALID,state=UNCHANGED,flags=VISIBLE,propID=INVALID), bitfield[0]=0xff. baseDepth=3 (faces at heap depth 3) carried in frameParams; maxRequiredMemory = 2*(u64_depth(heapID)-3)-1.

## Dispatch order
PER-FRAME DISPATCH ORDER (one refinement step; ported from mesh_updater.cpp; barriers are implicit between separate ComputeShader.dispatch calls on shared buffers — never fuse the counter-producer and counter-consumer passes). Reduce stays DIRECT per level (count=2^level data-independent, per GpuCbtKernel.runReduction); work-list passes dispatch INDIRECT from indirectArgs; live-count passes dispatch INDIRECT from liveDispatchArgs.

Pre-frame ONCE (after uploadSeed): runReduce() so pool_tree reflects the seeded bitfield before the first Allocate. whenReady() on ALL pipelines (dispatch is a no-op before isReady).

1. LiveDispatchArgs (1 thread): pool_count()->liveDispatchArgs (ceil/256, 2D spill) for Classify+Indexation.
2. Reset (1 group): zero classification[0,1], allocate[0], propagate[0,1], simplification[0], indirectDraw header; memory[0]=0 (alloc cursor), memory[1]=pool_freeCount() (i32 budget).
3. Classify (indirect/live): u64_depth(heapID); deterministic fixpoint metric (see risks); append BISECT to split list (atomicAdd classification[SPLIT_COUNTER]); append even-heapID SIMPLIFY candidates to simplify list; write bisectorData state.
4. PrepareIndirect(mode=split): classification[SPLIT_COUNTER] -> indirectArgs.
5. Split (indirect): early-out guards (n2==self && state!=UNCHANGED yields); BASE/twin-walk; atomicAdd(memory[1], -maxRequiredMemory) reserve (refund if prevBudget<req); atomicOr(bisectorData[twin*8+BD_PATTERN], FLAG) accumulation; append unique winner to allocate list.
6. PrepareIndirect(mode=allocate): allocate[0] -> indirectArgs.
7. Allocate (indirect): countOneBits(pattern) slots via atomicAdd(memory[0], n) -> disjoint base into pool_decodeBitComplement -> bisectorData.indices[k]. (NO pool_setBitAtomic here — tree is frozen.)
8. CopyNeighbors (compute copy, ceil(4*cap/256) groups, 2D spill): nbNext[i]=nbCurrent[i]. (No Babylon buffer-copy API — biggest deviation from HLSL.)
9. Bisect (indirect): switch on accumulated pattern (CENTER/RIGHT_DOUBLE/LEFT_DOUBLE/TRIPLE); set child heapIDs (u64 2h/4h+k); write nbNext cross-links for self+siblings; pool_setBitAtomic(true) for new child slots; record problematicNeighbor+propagationID(=parent); append to propagate list.
10. PrepareIndirect(mode=propBisect): propagate[0] -> indirectArgs.
11. PropagateBisect (indirect): patch nbNext rows that still reference the pre-split parent -> child/sibling (restores reciprocity).
12. (Optional, gated) Merge half: PrepareSimplify -> PrepareIndirect -> Simplify (collapse diamond, heapID/2 & clear, pool_setBitAtomic(false), push propagate[1]) -> PrepareIndirect -> PropagateSimplify. SPLIT half is mandatory scope; merge is the symmetric follow-on.
13. Pool REDUCE (leaf prepass level=DEPTH, then DEPTH-1..0): rebuild pool_tree from updated bitfield for next frame's Allocate + count readback.
14. Swap neighbor ping/pong PARITY: Bisect/Propagate wrote nbNext -> it becomes nbCurrent next frame.
15. Indexation (indirect/live): compact live slots (heapID!=0) -> bisectorIndices + indirectDraw args (atomicAdd reservation).
16. Readback live count = pool_tree[1] (non-forced read in live engine; forced read(...,true) in the dev cross-check).

Ping-pong is handled by PRE-BUILT AB/BA pipeline variants (copy/bisect/propBisect/index each built twice), picked by parity — Babylon binds StorageBuffers at setStorageBuffer time and cannot re-point per frame.

## Implementation steps
1. STEP 1 (smallest, pure, Node-testable) — FIX ocbt_engine_buffers.ts: change NEIGHBORS_WORDS 3->4 (flat stride with pad), update neighborsWords()/engineLayout()/buildEngineSeed() to stride 4 (pad lane=OCBT_INVALID); replace the single INDIRECT_DISPATCH(9)/INDIRECT_DRAW(10) plan with reusable indirectArgs(4 u32)+liveDispatchArgs(4 u32)+indirectDraw(10) and re-document MEMORY as array<atomic<i32>>. Extend ocbt_engine_buffers.test.ts: assert stride-4 neighbor layout, seed symmetry of the 4 base diamonds (0-4,1-5,2-6,3-7), all seed neighbor refs reciprocal after ref->oracle remap, baseDepth=3 from heapID 8..15. ALL GREEN before any GPU code.
2. STEP 2 — Add ocbt_topo_common.wgsl (pure helper include, no bindings/entry): INVALID_POINTER, lane consts (N0=LEFT,N1=RIGHT,N2=BASE), BisectorData field accessors over the flat stride-8 buffer, neighbor accessors over stride-4, HeapIDDepth=u64_depth wrapper, maxRequiredMemory(depth)=2*(depth-3)-1, ClassifyBisector deterministic metric, eval-leb vertex decode (port of ocbt_leb.ts). Compose-test it by reusing the existing pool harness compose path (compile-only smoke). Depends on ocbt_u64.wgsl + ocbt_pool.wgsl (both exist).
3. STEP 3 — Add the trivially-correct passes as standalone WGSL + tiny harness extensions, each independently GPU-checkable against a hand-computed expectation: (a) ocbt_topo_reset.compute.wgsl, (b) ocbt_topo_prepare_indirect.compute.wgsl (mode-driven count->args, mirror cbt_dispatch_args 2D spill), (c) ocbt_topo_copy_neighbors.compute.wgsl, (d) ocbt_topo_live_dispatch.compute.wgsl. Cross-check: upload a known bitfield+counters, run each, read back args/copies. These have no concurrency subtlety.
4. STEP 4 — Add ocbt_topo_classify.compute.wgsl (live dispatch, deterministic fixpoint metric writing split/simplify lists). Test: seed 8 roots, classify with a target-depth metric, assert the split list == the set the CPU oracle's identical predicate selects (heapID multiset, order-independent).
5. STEP 5 — Add ocbt_topo_split.compute.wgsl (atomicOr pattern accumulation + memory reserve/refund + BASE twin-walk + allocate-list append). Hardest concurrency piece — test in ISOLATION: seed, classify, split; read back accumulated patterns + allocate list; assert the union-of-demands pattern equals the 4 legal unions and the memory budget never under-commits. Use validation buffer counters.
6. STEP 6 — Add ocbt_topo_allocate.compute.wgsl (disjoint atomicAdd(memory[0]) base -> pool_decodeBitComplement -> indices). Requires a FRESH reduce first. Test: assert allocated slots are pairwise-disjoint and all from the free set of the frozen tree.
7. STEP 7 — Add ocbt_topo_bisect.compute.wgsl (4 patterns, child heapIDs via u64, nbNext cross-links, pool bit set, propagate append) + ocbt_topo_propagate_bisect.compute.wgsl (reciprocity fixup). Build AB/BA variants. Test after a single split batch: neighbor reciprocity holds in nbNext post-propagate.
8. STEP 8 — Write OcbtTopologyKernel (src/systems/lod/cbt/ocbt/ocbt_topology_kernel.ts): owns all StorageBuffers via engineLayout()+creation flags (mirror GpuCbtKernel/OcbtPoolGpuHarness), builds every pass + AB/BA variants + prepUbo[]/reduceUbo[] arrays, uploadSeed()+runReduce(), whenReady() over ALL pipelines, runFrame(metricParams) executing the dispatch order, parity swap, readback helpers (heapID, neighbors, count).
9. STEP 9 — Write the cross-check: ocbt_topology_gpu_harness.ts (drives N fixpoint refine frames on the kernel, reads heapID+neighbors with read(0,undefined,undefined,true)) + ocbt_topology_gpu_test_main.ts (twin of ocbt_pool_gpu_test_main: own WebGPU engine, drive OcbtTopology oracle with the IDENTICAL fixpoint predicate, assert 4 invariants per-frame, DOM PASS/FAIL + window.__OCBT_TOPO_RESULT__). Register a NEW rspack dev entry (ocbtTopoTest) + ocbt-topo-test.html so the existing pool page is untouched.
10. STEP 10 — (Follow-on, out of mandatory scope) merge passes (PrepareSimplify/Simplify/PropagateSimplify) as the symmetric dual, gated by enableSimplify; second cross-check scenario refines to target A then moves to B exercising mixed split/merge with per-frame invariant asserts.

## Risks
TOP CORRECTNESS RISKS:
1. CROSS-CHECK COMPARES SLOTS (fatal, all 4 drafts). Concurrent decode_bit_complement hands out free slots in a different order than the oracle's sequential free-stack. MITIGATION: compare ONLY invariants — live heapID multiset (sorted), neighbor reciprocity (after ref n0/n1/n2 -> oracle BASE/LEFT/RIGHT remap), 0 T-junctions via lebDecode'd verts. NEVER raw slot ids.
2. DEPTH CONVENTION (+1). World42 u64Depth/lebDepth = firstLeadingBit (NO +1); faces 8..15 => depth 3; reference HeapIDDepth = firstbithigh+1. MITIGATION: WGSL uses u64_depth everywhere; baseDepth=3; maxRequiredMemory=2*(depth-3)-1. TS cross-check uses lebDepth on readback heapIDs and passes that into lebDecode — never the reference +1 formula.
3. FP-INSTABILITY OF THE METRIC. Order-independence is necessary but NOT sufficient; f32 (GPU) vs f64 (CPU oracle) can flip a borderline leaf and break the multiset. MITIGATION: deterministic depth/distance fixpoint metric with targets placed in face interiors and a cap margin >1e-4; round CPU dot+cap via Math.fround before comparing. Assert invariants AFTER EACH frame (transient T-junctions a later pass heals are otherwise missed).
4. FIXPOINT not reached in one frame. GPU splits in batches; LEPP conformity cascades. MITIGATION: loop kernel.runFrame() until live count stable across two reads before comparing; oracle runs its until-0-splits loop.
5. ALLOCATE ON A STALE TREE. pool_decodeBitComplement walks pool_tree, so Allocate is only correct if the tree was reduced from the start-of-frame bitfield AND no bit is set during Allocate. MITIGATION: runReduce() after seed and at END of every frame; set pool bits only in Bisect (after Allocate); disjoint atomicAdd(memory[0]) handles against the frozen tree.
6. heapID exactness on readback: u64 carried as (lo,hi); reconstruct hi*2^32+lo only valid < 2^53. Keep test depth low (level+3, level<=~50 stays exact for the levels tested) or compare as (lo,hi) pairs/BigInt at extreme depth.

TOP WEBGPU RISKS:
A. >8 storage buffers/stage exceeds default adapter limits. MITIGATION: per-pass bind groups, each <=8 buffers; declare ONLY referenced bindings (reflection strips the rest — binding an absent slot invalidates the whole group, already hit in the decode pass).
B. array<vec3<u32>> 16-byte stride trap. MITIGATION: flat array<u32> stride 4 for neighbors (forces the STEP-1 fix to ocbt_engine_buffers.ts NEIGHBORS_WORDS 3->4).
C. Fixed bind groups cannot be re-pointed per frame. MITIGATION: pre-built AB/BA pipeline variants for copy/bisect/propBisect/index, picked by parity (same trick GpuCbtKernel uses for per-level UBOs).
D. UBO write coalescing: one UBO written between same-submit dispatches makes all see the last value. MITIGATION: prepUbo[0..4] (per PrepareIndirect mode) and reduceUbo[0..depth] (per level), one instance each.
E. Indirect args not ready before consumer reads them. MITIGATION: a 1-thread PrepareIndirect pass writes ceil(count/256) (2D spill) into an INDIRECT StorageBuffer BEFORE the work pass; never fuse counter-producer/consumer; rely on Babylon's between-dispatch barriers; Reset before Classify.
F. dispatch no-ops until isReady() + readback needs forced flush. MITIGATION: whenReady() polling on all ~17 pipelines; dev readback uses read(0,undefined,undefined,true) (noDelay forces flushFramebuffer — no render loop), live engine uses non-forced read.
G. atomicAdd has no negative literal in WGSL. MITIGATION: memory is array<atomic<i32>>; reserve with atomicAdd(&memory[1], -i32(maxReq)) and refund the SAME amount if the returned prior value < req (signed, transiently negative is fine).

## Convention resolutions
CONFLICT 1 — Neighbor stored order. draft:buffers/draft:wgsl-engine/draft:kernel store REFERENCE order (n0=LEFT,n1=RIGHT,n2=BASE); draft:crosscheck asks the kernel to store World42 [BASE,LEFT,RIGHT]. RESOLUTION: REFERENCE order WINS — it is already committed in ocbt_engine_buffers.ts (BINDING/N0/N1/N2 + buildEngineSeed remap) and lets the proven HLSL Split/Bisect/Propagate port verbatim (n[0]/n[1]/n[2] literally). The lane swap is confined to ONE TS comparator (oracle [BASE,LEFT,RIGHT] -> [n0,n1,n2]=[LEFT,RIGHT,BASE]). The harness reciprocity check scans all 3 lanes so it is order-robust regardless. LOCKED.

CONFLICT 2 — Neighbor element type/stride. draft:wgsl-engine sketches array<vec3<u32>> (16-byte stride); draft:buffers/draft:kernel and every PITFALLS section say store FLAT 3 or 4 u32. The committed ocbt_engine_buffers.ts uses NEIGHBORS_WORDS=3 (tight). RESOLUTION: FLAT array<u32> with stride 4 (n0,n1,n2,pad). 4 not 3 because the GPU buffer must avoid the vec3 trap AND give predictable element indexing for copy/readback; the extra pad lane is cheap (cap*4B) and makes nbNext[i]=nbCurrent[i] a clean per-u32 copy. ACTION: bump NEIGHBORS_WORDS 3->4 in STEP 1 (the one concrete edit to existing committed code).

CONFLICT 3 — bisectorData representation. draft:wgsl-engine hoists subdivisionPattern into its OWN array<atomic<u32>> (_SubdivPattern) + separate plain arrays (_Indices0/1/2/_State/...); draft:buffers/draft:kernel keep ONE flat stride-8 array<u32> re-declared as array<atomic<u32>> per pass. RESOLUTION: ONE flat stride-8 buffer (the committed BD_* layout) re-declared array<atomic<u32>> in Split/Bisect/Classify and array<u32> elsewhere — legal because each pass is a separate compose unit (confirmed by how ocbt_pool.wgsl's bitfield is atomic in reduce, and decode never binds it). This avoids exploding 8 fields into 8 bindings (which would blow the per-stage buffer limit). The draft:wgsl-engine split-buffer scheme is rejected.

CONFLICT 4 — memory buffer signedness. draft:wgsl-engine says store u32 + atomicSub + underflow guard; draft:buffers/draft:kernel and the committed plan say array<atomic<i32>>. RESOLUTION: array<atomic<i32>> (signed) — matches the reference InterlockedAdd(memory[1], -maxReq) directly and is already the committed MEMORY layout. atomicAdd with negative i32 + refund.

CONFLICT 5 — single mega bind group vs per-pass groups. draft:wgsl-engine BINDINGS shows one 21-binding group 0; its own PITFALLS and draft:buffers/draft:kernel say split per pass (<=8). RESOLUTION: per-pass bind groups. The BINDING map assigns each buffer a STABLE binding NUMBER (so the WGSL @binding is consistent), but each ComputeShader's bindingsMapping + setStorageBuffer lists ONLY the buffers that pass uses. Mandatory on adapters with the 8-buffer default limit.

CONFLICT 6 — indirect buffers layout. The committed ocbt_engine_buffers.ts has a single INDIRECT_DISPATCH(9 u32) holding 3 arg-triples. draft:kernel/draft:wgsl-engine use a reusable 4-u32 indirectArgs written per work pass + a separate liveDispatchArgs, mirroring the existing cbt_dispatch_args.compute.wgsl. RESOLUTION: adopt the reusable 4-u32 indirectArgs + liveDispatchArgs scheme (proven pattern, 2D spill already implemented) and retire the 9-u32 triple buffer. ACTION in STEP 1.

CONFLICT 7 — file naming (drafts vs reality). Drafts reference ocbt_pool.wgsl/ocbt_u64.wgsl/ocbt_buffers.ts as if novel; they ALREADY EXIST (WGSL under src/assets/shaders/cbt/ocbt/, TS as ocbt_buffers.ts/ocbt_pool.ts/ocbt_u64.ts). RESOLUTION: new engine WGSL goes in src/assets/shaders/cbt/ocbt/ as ocbt_topo_*.compute.wgsl + ocbt_topo_common.wgsl, composed via the existing preamble pattern (poolWgslPreamble + engineWgslPreamble + ocbt_u64.wgsl + ocbt_pool.wgsl + ocbt_topo_common.wgsl + pass). The TS kernel/harness are NEW files alongside ocbt_pool_gpu_harness.ts. No existing file is renamed; only ocbt_engine_buffers.ts is edited (STEP 1).


## DRAFT: draft:buffers

### design
PIECE = GPU buffer layout for the concurrent OCBT bisector engine. Delivered as a new pure module `src/systems/lod/cbt/ocbt/ocbt_engine_buffers.ts` (no Babylon import, Node-testable) sitting ALONGSIDE the existing `ocbt_buffers.ts` (which stays the pool bitfield+tree authority). New test `ocbt_engine_buffers.test.ts` (12 tests, all green).

ELEMENT ADDRESSING. Every per-bisector buffer is indexed by POOL SLOT in [0, CAPACITY). The reference's `totalNumElements` == World42 pool `capacity` (default 2^18 = 262144). The pool bitfield (binding 0) + sum-tree (binding 1) from ocbt_buffers.ts are REUSED unchanged: they mark live slots and `pool_decodeBitComplement` feeds AllocateElement. CAPACITY is a power of two (sum-tree requires it); subdivision depth is decoupled from it (the OCBT point).

NEIGHBOR CONVENTION MAP (confirmed from bisector.hlsl + ocbt_topology.ts). Reference uint3 (n0,n1,n2): n2 = twin = split-edge/hypotenuse; n0/n1 = the two leg neighbors. World42 mirror [BASE,LEFT,RIGHT]: BASE = hypotenuse twin, LEFT/RIGHT = legs. So the map is n2<->BASE, n0<->LEFT, n1<->RIGHT. DECISION: the GPU NeighborsBuffer stores triples in REFERENCE (n0,n1,n2) order, because the ported Split/Bisect/Propagate WGSL indexes n[0]/n[1]/n[2] literally (e.g. SplitElement reads cNeighbors.z as twin; BisectElement's RIGHT_DOUBLE branch checks nNeighbors[0]==currentID). The CPU mirror stays in [BASE,LEFT,RIGHT]; the cross-check translates indices, never compares raw slots. The seed packer does the one-time remap (n0=LEFT, n1=RIGHT, n2=BASE).

BUFFER SET (binding plan, group 0, all read_write storage unless noted):
  0  pool_bitfield      array<atomic<u32>>   ceil(cap/32) words           (reuse ocbt_buffers)
  1  pool_tree          array<u32>           2*cap words                   (reuse ocbt_buffers)
  2  heapID             array<vec2<u32>>     cap*2 u32   (u64 lo,hi; WGSL has no u64)
  3  neighbors (PING)   array<vec3<u32>>     cap*3 u32   read this frame
  4  neighborsOut(PONG) array<vec3<u32>>     cap*3 u32   write this frame (swap each frame)
  5  bisectorData       array<u32>           cap*8 u32   FLAT stride-8 (see packing) — NOT a WGSL struct array
  6  classification     array<atomic<u32>>   2 + 2*cap   [0]=SPLIT_COUNTER [1]=SIMPLIFY_COUNTER, then split list (<=cap) + simplify list (<=cap)
  7  simplification     array<atomic<u32>>   1 + cap     [0]=count, then PrepareSimplify list
  8  allocate           array<atomic<u32>>   1 + cap     [0]=count, then to-allocate list
  9  propagate          array<atomic<u32>>   2 + cap     [0]=split-prop count [1]=simplify-prop count, then list
 10  memory             array<atomic<i32>>   2           [0]=allocCursor (decode_bit_complement base) [1]=remainingFreeSlots (atomic reservation)
 11  indirectDispatch   array<u32>           9           3 dispatch-arg triples (classify/allocate/propagate), INDIRECT flag
 12  indirectDraw       array<atomic<u32>>   10          2 draw-arg quads (4*2) + bisector-indexation counters, INDIRECT flag
 13  bisectorIndices    array<u32>           cap         compacted live-leaf list (BisectorElementIndexation)
 14  visibleIndices     array<u32>           cap
 15  modifiedIndices    array<u32>           cap
 16  validation         array<atomic<u32>>   1           dev-only conformity counter (ValidateBisector)
 17  updateParams       uniform                          camera-local pos, radius, focal, split/merge thresholds, baseDepth(=3), liveCount, parity

PING-PONG: neighbors needs two buffers because BisectElement reads parent neighbors from PING while writing children neighbors to PONG (PropagateBisectElement then patches PONG in place); swap bindings 3<->4 each update. heapID, bisectorData, pool are single-buffered (updated in place, atomics guard races).

BISECTORDATA PACKING. 8 u32 = 32 bytes/slot, field offsets: [0]subdivisionPattern, [1..3]indices[3], [4]problematicNeighbor, [5]bisectorState(i32 bits), [6]flags, [7]propagationID. DECISION: store as a flat array<u32> view (stride 8) rather than `array<BisectorData>` so there is zero std430 struct padding to reason about and `atomicOr` on `subdivisionPattern` (SplitElement's reservation handshake) and `bisectorState` work cleanly — atomics require array<atomic<u32>> element type, which a struct field cannot be. So bisectorData is declared `array<atomic<u32>>` and addressed slot*8 + BD_FIELD.

PER-FRAME PASS ORDER (from mesh_updater.cpp, to be driven by the kernel piece): ResetBuffers -> Classify (indirect) -> Split (atomic reserve + BASE twin-walk) -> PrepareIndirect(allocate) -> Allocate (decode_bit_complement) -> Bisect (4 patterns, write PONG) -> PrepareIndirect(propagate) -> PropagateBisect -> PrepareSimplify -> Simplify -> PropagateSimplify -> pool reduce (leaf prepass + levels D-1..0, reuse harness pattern) -> BisectorIndexation -> PrepareBisectorIndirect. Swap neighbor ping/pong after Propagate.

SEED. buildEngineSeed(capacity) returns prefixes for the 8 octahedron roots at slots 0..7: heapID[i]=8+i (lo=8+i, hi=0; depth 3), neighbors remapped from ROOT_NEIGHBORS_W42 into (n0=LEFT,n1=RIGHT,n2=BASE), bisectorData defaulted (pattern=0, indices=INVALID, state=UNCHANGED, flags=VISIBLE, propID=INVALID), and bitfield[0]=0xff (slots 0..7 allocated). Caller uploads each prefix into the front of the full-cap buffer; the rest stays zero (= free slot / heapID 0, which BisectElement/Indexation treat as dead). Tests prove seed twins n2 form the 4 reciprocal base diamonds (0-4,1-5,2-6,3-7) and ALL seed neighbor refs are symmetric — the exact invariants the GPU<->mirror cross-check will assert.

SIZING (functions of capacity, all in ocbt_engine_buffers.ts, verified against reference mesh.cpp): heapIdWords=2*cap, neighborsWords=3*cap, bisectorDataWords=8*cap, classificationWords=2+2*cap, simplificationWords=1+cap, allocateWords=1+cap, propagateWords=2+cap, MEMORY_WORDS=2, INDIRECT_DISPATCH_WORDS=9, INDIRECT_DRAW_WORDS=10, bisectorIndices=cap (x3). engineLayout(cap) returns all byte sizes + totalBytes (counts ping+pong + 3 index lists). At 2^18: heapID 2MiB, neighbors 3MiB x2, bisectorData 8MiB, classification ~4MiB, plus pool ~2.03MiB — engine peak ~26MiB/planet (dominated by bisectorData + neighbors; drop capacity to 2^17 to halve).

BufferCreationFlags (for the kernel piece, mirrors gpu_cbt_kernel.ts): per-slot + work buffers = STORAGE|WRITE (CopyDst, Babylon zero-init + CPU seed); buffers read back for cross-check (heapID, neighbors, bisectorData, pool_tree, indices) add READ (CopySrc); indirectDispatch/indirectDraw add INDIRECT; pool_bitfield is STORAGE|WRITE (atomic, seeded). updateParams is a UniformBuffer.

### bindings
Group 0 binding plan (extends ocbt_buffers.ts bindings 0/1 which stay the pool authority):
 0  pool_bitfield     array<atomic<u32>>   ceil(cap/32)*4 B        STORAGE|WRITE         (reuse)
 1  pool_tree         array<u32>           2*cap*4 B               STORAGE|READ|WRITE    (reuse)
 2  heapID            array<vec2<u32>>     cap*2*4 B  (=2MiB@2^18)  STORAGE|WRITE|READ
 3  neighbors PING    array<vec3<u32>>     cap*3*4 B  (=3MiB@2^18)  STORAGE|WRITE|READ
 4  neighborsOut PONG array<vec3<u32>>     cap*3*4 B               STORAGE|WRITE|READ
 5  bisectorData      array<atomic<u32>>   cap*8*4 B  (=8MiB@2^18)  STORAGE|WRITE|READ    (flat stride 8; atomicOr on pattern/state)
 6  classification    array<atomic<u32>>   (2+2*cap)*4 B           STORAGE|WRITE
 7  simplification    array<atomic<u32>>   (1+cap)*4 B             STORAGE|WRITE
 8  allocate          array<atomic<u32>>   (1+cap)*4 B             STORAGE|WRITE
 9  propagate         array<atomic<u32>>   (2+cap)*4 B             STORAGE|WRITE
 10 memory            array<atomic<i32>>   2*4 = 8 B               STORAGE|WRITE         ([0]=allocCursor [1]=remainingFree; atomicAdd reservation)
 11 indirectDispatch  array<u32>           9*4 = 36 B              STORAGE|INDIRECT|WRITE
 12 indirectDraw      array<atomic<u32>>   10*4 = 40 B             STORAGE|INDIRECT|WRITE
 13 bisectorIndices   array<u32>           cap*4 B                 STORAGE|READ          (compacted live list)
 14 visibleIndices    array<u32>           cap*4 B                 STORAGE|READ
 15 modifiedIndices   array<u32>           cap*4 B                 STORAGE|READ
 16 validation        array<atomic<u32>>   4 B                     STORAGE|READ|WRITE    (dev-only)
 17 updateParams      uniform (UniformBuffer): vec4 camLocal+radius, vec4 focal+splitThr+mergeThr+cullDot, ivec4 baseDepth(3)+parity+liveCount+pad

Per-slot strides (u32): HEAP_ID_WORDS=2, NEIGHBORS_WORDS=3, BISECTOR_DATA_WORDS=8.
BisectorData field offsets (slot*8 + f): 0 pattern, 1-3 indices[3], 4 problematicNeighbor, 5 state(i32 bits), 6 flags, 7 propagationID.
Work-buffer headers (u32): classification[0]=SPLIT_COUNTER [1]=SIMPLIFY_COUNTER; simplification[0]/allocate[0]=count; propagate[0]=split-prop [1]=simplify-prop.
Neighbor stored order = reference (n0=LEFT@0, n1=RIGHT@1, n2=BASE/twin@2). Seed slots 0..7 = octahedron roots, heapID 8..15.
Default capacity 2^18 (262144); drop to 2^17 to halve memory. Engine peak ~26 MiB/planet (heapID 2 + neighbors 3*2 + bisectorData 8 + classification 4 + pool 2.03 + indices 3 + small).

### codeDraft
```
// FILE: src/systems/lod/cbt/ocbt/ocbt_engine_buffers.ts  (WRITTEN + TESTED, 12 passing tests)
// Full source is on disk; key excerpts (the load-bearing decisions) below.

// --- sentinels / enums (mirror bisector.hlsl + ocbt_topology.ts) ---
export const OCBT_INVALID = 0xffffffff >>> 0;
export const NO_SPLIT=0x00, CENTER_SPLIT=0x01, RIGHT_SPLIT=0x02, LEFT_SPLIT=0x04;
export const RIGHT_DOUBLE_SPLIT=CENTER_SPLIT|RIGHT_SPLIT;       // 0x03
export const LEFT_DOUBLE_SPLIT=CENTER_SPLIT|LEFT_SPLIT;         // 0x05
export const TRIPLE_SPLIT=CENTER_SPLIT|RIGHT_SPLIT|LEFT_SPLIT;  // 0x07
export const BACK_FACE_CULLED=-3, FRUSTUM_CULLED=-2, TOO_SMALL=-1,
    UNCHANGED_ELEMENT=0, BISECT_ELEMENT=1, SIMPLIFY_ELEMENT=2, MERGED_ELEMENT=3;
export const VISIBLE_BISECTOR=0x1, MODIFIED_BISECTOR=0x2;

// neighbor edge order WITHIN a stored vec3<u32> = REFERENCE (n0,n1,n2):
export const N0=0 /*=World42 LEFT*/, N1=1 /*=RIGHT*/, N2=2 /*=BASE/twin*/;
export const W42_BASE=0, W42_LEFT=1, W42_RIGHT=2;

export const BINDING = {
  POOL_BITFIELD:0, POOL_TREE:1, HEAP_ID:2, NEIGHBORS:3, NEIGHBORS_OUT:4,
  BISECTOR_DATA:5, CLASSIFICATION:6, SIMPLIFICATION:7, ALLOCATE:8, PROPAGATE:9,
  MEMORY:10, INDIRECT_DISPATCH:11, INDIRECT_DRAW:12, BISECTOR_INDICES:13,
  VISIBLE_INDICES:14, MODIFIED_INDICES:15, VALIDATION:16, UPDATE_PARAMS:17
} as const;

export const HEAP_ID_WORDS=2, NEIGHBORS_WORDS=3, BISECTOR_DATA_WORDS=8;
export const BD_PATTERN=0, BD_INDEX0=1, BD_INDEX1=2, BD_INDEX2=3,
    BD_PROBLEMATIC=4, BD_STATE=5, BD_FLAGS=6, BD_PROPAGATION=7;
export const CLASSIFY_HEADER=2, SIMPLIFY_HEADER=1, ALLOCATE_HEADER=1,
    PROPAGATE_HEADER=2, MEMORY_WORDS=2, INDIRECT_DISPATCH_WORDS=9,
    INDIRECT_DRAW_WORDS=10, VALIDATION_WORDS=1;

// sizing (pure; assertPowerOfTwo/bitfieldWordCount from ocbt_pool.ts):
export function heapIdWords(c:number){assertPowerOfTwo(c);return c*HEAP_ID_WORDS;}
export function neighborsWords(c:number){assertPowerOfTwo(c);return c*NEIGHBORS_WORDS;}
export function bisectorDataWords(c:number){assertPowerOfTwo(c);return c*BISECTOR_DATA_WORDS;}
export function classificationWords(c:number){assertPowerOfTwo(c);return CLASSIFY_HEADER+2*c;}
export function simplificationWords(c:number){assertPowerOfTwo(c);return SIMPLIFY_HEADER+c;}
export function allocateWords(c:number){assertPowerOfTwo(c);return ALLOCATE_HEADER+c;}
export function propagateWords(c:number){assertPowerOfTwo(c);return PROPAGATE_HEADER+c;}
export function engineLayout(capacity=OCBT_DEFAULT_CAPACITY): EngineBufferLayout {
  // returns {heapIdBytes, neighborsBytes (ONE buf), bisectorDataBytes, classification..,
  //          memoryBytes:8, indirectDispatchBytes:36, indirectDrawBytes:40,
  //          bisectorIndicesBytes:c*4, totalBytes = sum w/ 2*neighbors + 3*indices}
}

// SEED — mirror of ROOT_NEIGHBORS (ocbt_topology.ts), [BASE,LEFT,RIGHT]:
const ROOT_NEIGHBORS_W42 = [[4,3,1],[5,0,2],[6,1,3],[7,2,0],[0,7,5],[1,4,6],[2,5,7],[3,6,4]] as const;
export function buildEngineSeed(capacity=OCBT_DEFAULT_CAPACITY): EngineSeed {
  assertPowerOfTwo(capacity);
  const heapID=new Uint32Array(8*HEAP_ID_WORDS);
  const neighbors=new Uint32Array(8*NEIGHBORS_WORDS);
  const bisectorData=new Uint32Array(8*BISECTOR_DATA_WORDS);
  for(let i=0;i<8;i++){
    heapID[i*2]= (8+i)>>>0; heapID[i*2+1]=0;                // u64 lo,hi (depth 3)
    const [base,left,right]=ROOT_NEIGHBORS_W42[i];
    neighbors[i*3+N0]=left>>>0; neighbors[i*3+N1]=right>>>0; neighbors[i*3+N2]=base>>>0;
    const b=i*8;
    bisectorData[b+BD_PATTERN]=NO_SPLIT;
    bisectorData[b+BD_INDEX0]=OCBT_INVALID; bisectorData[b+BD_INDEX1]=OCBT_INVALID; bisectorData[b+BD_INDEX2]=OCBT_INVALID;
    bisectorData[b+BD_PROBLEMATIC]=OCBT_INVALID;
    bisectorData[b+BD_STATE]=UNCHANGED_ELEMENT>>>0;
    bisectorData[b+BD_FLAGS]=VISIBLE_BISECTOR;
    bisectorData[b+BD_PROPAGATION]=OCBT_INVALID;
  }
  const bitfield=new Uint32Array(bitfieldWordCount(capacity)); bitfield[0]=0xff; // slots 0..7
  return {heapID, neighbors, bisectorData, bitfield, liveCount:8};
}

export function engineWgslPreamble(capacity=OCBT_DEFAULT_CAPACITY): string {
  const depth=31-Math.clz32(capacity);
  return `const OCBT_CAPACITY : u32 = ${capacity>>>0}u;\n`+
         `const OCBT_DEPTH : u32 = ${depth}u;\n`+
         `const OCBT_INVALID : u32 = 4294967295u;\n`+
         `const BISECTOR_DATA_WORDS : u32 = ${BISECTOR_DATA_WORDS}u;\n`;
}

/* ============================================================================
   WGSL DECL SKETCH the kernel piece prepends after engineWgslPreamble + ocbt_pool.wgsl
   (atomics only on u32; bisectorData/memory/classification/etc. are atomic arrays):
   ----------------------------------------------------------------------------
   @group(0) @binding(2)  var<storage, read_write> heapID        : array<vec2<u32>>;
   @group(0) @binding(3)  var<storage, read_write> neighbors     : array<vec3<u32>>; // PING
   @group(0) @binding(4)  var<storage, read_write> neighborsOut  : array<vec3<u32>>; // PONG
   @group(0) @binding(5)  var<storage, read_write> bisectorData  : array<atomic<u32>>; // stride 8
   @group(0) @binding(6)  var<storage, read_write> classification: array<atomic<u32>>;
   @group(0) @binding(7)  var<storage, read_write> simplification: array<atomic<u32>>;
   @group(0) @binding(8)  var<storage, read_write> allocate      : array<atomic<u32>>;
   @group(0) @binding(9)  var<storage, read_write> propagate     : array<atomic<u32>>;
   @group(0) @binding(10) var<storage, read_write> memory        : array<atomic<i32>>;
   @group(0) @binding(11) var<storage, read_write> indirectDispatch : array<u32>;
   @group(0) @binding(12) var<storage, read_write> indirectDraw  : array<atomic<u32>>;
   @group(0) @binding(13) var<storage, read_write> bisectorIndices  : array<u32>;
   @group(0) @binding(14) var<storage, read_write> visibleIndices   : array<u32>;
   @group(0) @binding(15) var<storage, read_write> modifiedIndices  : array<u32>;
   @group(0) @binding(16) var<storage, read_write> validation    : array<atomic<u32>>;
   // BisectorData accessors over the flat atomic array (slot*8 + field):
   fn bd_load(slot:u32, f:u32)->u32 { return atomicLoad(&bisectorData[slot*BISECTOR_DATA_WORDS+f]); }
   fn bd_store(slot:u32, f:u32, v:u32){ atomicStore(&bisectorData[slot*BISECTOR_DATA_WORDS+f], v); }
   fn bd_orPattern(slot:u32, m:u32)->u32 { return atomicOr(&bisectorData[slot*BISECTOR_DATA_WORDS+0u], m); } // SplitElement handshake
   ============================================================================ */

// FILE: src/systems/lod/cbt/ocbt/ocbt_engine_buffers.test.ts  (WRITTEN + GREEN)
// 12 tests: strides, headers vs reference, layout total == sum, distinct bindings,
// seed heapIDs 8..15, bitfield 0xff, [BASE,LEFT,RIGHT]->(n0,n1,n2) remap, base-diamond
// twin reciprocity (0-4,1-5,2-6,3-7), FULL neighbor symmetry, bisectorData defaults,
// preamble consts. Run: npx vitest run src/systems/lod/cbt/ocbt/ocbt_engine_buffers.test.ts
```

### pitfalls
- WGSL has no u64: heapID is array<vec2<u32>> [lo,hi]. Decode/depth/split (2h, 4h+k) must use the ocbt_u64.ts shift/add semantics in WGSL — never shift a u32 by >=32 (UB); route >=32 shifts through the other lane. Root heapIDs 8..15 fit in lo only (hi=0).
- atomics only on u32/i32: bisectorData MUST be array<atomic<u32>> (flat stride 8), NOT array<StructBisectorData> — SplitElement does atomicOr on subdivisionPattern as its memory-reservation handshake, and you cannot atomicOr a struct field. memory is array<atomic<i32>> because SplitElement does InterlockedAdd(memory[1], -maxRequiredMemory) (signed, can go negative then is added back).
- std430 alignment: array<vec3<u32>> elements are 16-byte aligned in WGSL (vec3 has 16B stride, not 12B). If you instead declare neighbors as array<u32> (3 per slot) you save 25% AND match the reference's tight uint3 packing and the CPU mirror's *3 stride. RECOMMENDATION confirmed by seed test (uses *3 stride). Pick array<u32> stride-3, not array<vec3<u32>>, unless you accept 16B/element. (The decl sketch shows vec3 for clarity but the SIZING uses 3 u32 = tight — keep them consistent: use array<u32>.)
- Ping-pong neighbors: BisectElement reads parent neighbors from binding 3 and writes children to binding 4; do NOT read-modify-write the same neighbor buffer in one pass (concurrent BASE twin-walk reads neighbors of slots other threads are mutating). Swap the 3<->4 bindingsMapping each frame; PropagateBisect patches the NEW (PONG) buffer in place.
- Babylon ComputeShader reflection strips unbound slots: each pass must declare ONLY the buffers it uses and bind exactly those, else binding an absent slot invalidates the whole bind group (already hit in ocbt_pool_gpu_harness decode pass). With 16 storage buffers + a uniform you may exceed the default 8-10 storage-buffer-per-stage limit on some adapters — split the engine into per-pass bind groups (each pass uses <=8) rather than one mega layout.
- Indirect buffers (indirectDispatch=9 u32, indirectDraw=10 u32) need BUFFER_CREATIONFLAG_INDIRECT AND must be written by a prior compute pass with a UAV/storage barrier before dispatchIndirect reads them (mesh_updater.cpp issues uav_barrier_buffer). Babylon inserts barriers between dispatches in the same submit, but verify ordering: ResetBuffers must run before Classify reads indirectDispatch.
- Concurrent allocation order is NON-deterministic vs the sequential CPU mirror: pool slots assigned by decode_bit_complement(atomicAdd cursor) differ run-to-run. The GPU<->mirror cross-check (the seed symmetry/reciprocity tests are the template) MUST compare INVARIANTS — live heapID multiset, neighbor symmetry/reciprocity after translating n0/n1/n2<->BASE/LEFT/RIGHT, and 0 T-junctions via lebDecode'd verts — NEVER raw slot indices.
- SplitElement's maxRequiredMemory = 2*(depth-baseDepth)-1 with baseDepth=3 (octahedron roots at depth 3). Seeding baseDepth wrong (e.g. 0) over-reserves and starves the pool. updateParams must carry baseDepth=3 to match heapID 8..15.
- readback after dispatch with no render loop needs StorageBuffer.read(0,undefined,undefined,true) (noDelay forces flushFramebuffer) — same as the pool harness; a non-forced read never resolves in the dev test main.
- INVALID_POINTER = 0xFFFFFFFF (4294967295) on GPU, but the CPU mirror uses -1. The seed packer writes 0xFFFFFFFF; the cross-check must treat 0xFFFFFFFF and -1 as the same 'no neighbor' sentinel when translating.


## DRAFT: draft:wgsl-engine

### design

# OCBT GPU compute engine (WGSL) — design

## 0. Convention reconciliation (load-bearing)

Reference uses `uint3 neighbors=(n0,n1,n2)` with **n2 = twin** (hypotenuse/split-edge neighbor); n0/n1 are leg neighbors (Next/Prev). The World42 oracle (ocbt_topology.ts) uses `[BASE=0, LEFT=1, RIGHT=2]` where BASE is the hypotenuse/split-edge twin. Mapping:

    World42 BASE(0)  == reference n2 (twin)
    World42 LEFT(1)  == reference n0
    World42 RIGHT(2) == reference n1

DECISION: store the neighbor buffer in **reference order [n0,n1,n2]** so the ported HLSL index math (`cNeighbors[0/1/2]`, `nNeighbors[0]/[1]`, `[2]`) ports verbatim with zero juggling. Expose `nb_left(v)=v.x`, `nb_right(v)=v.y`, `nb_twin(v)=v.z`. The GPU↔oracle cross-check remaps oracle `[BASE,LEFT,RIGHT]`→`[LEFT,RIGHT,BASE]=[n0,n1,n2]` once, in TS. This confines the convention swap to one TS comparator and keeps WGSL a line-by-line port of the proven HLSL (lowest risk).

INVALID_POINTER = 0xFFFFFFFFu (reference); oracle uses -1 → remap in TS.

## 1. heapID depth convention

World42 `u64_depth` (ocbt_u64.wgsl) = `firstLeadingBit(heapID)` (NO +1). Octahedron faces are heap nodes 8..15 → depth 3. The reference's `HeapIDDepth = firstbithigh+1` (root id=1 → depth 1); World42 carries the +3 face offset instead. So `baseDepth = 3u`, and everywhere the reference compares depths I call `u64_depth()`. `maxRequiredMemory = 2*(currentDepth - baseDepth) - 1` uses `baseDepth=3`.

Child heapID arithmetic is identical bit-math (2h, 2h+1, 4h, 4h+1, 4h+2, 4h+3), done in u64: `u64_or(u64_shl(h,1), u64_from_u32(k))` etc. The oracle's subdivide() picks which child gets 2h vs 2h+1 by GEOMETRY MATCH against lebDecode — but the reference does NOT store verts, it derives geometry purely from heapID via leb decode at draw time. So the GPU path follows the reference: it assigns heapIDs by the fixed pattern formulas (CENTER/RIGHT_DOUBLE/LEFT_DOUBLE/TRIPLE) and never stores verts. The cross-check then compares the **decoded vertex sets** (via ocbt_leb on each side), which is exactly the test the oracle uses to validate its own 2h/2h+1 assignment. This means GPU heapID multiset == oracle heapID multiset is the invariant, NOT slot identity.

## 2. Buffers consumed (from the buffers piece) — reference order

- `_HeapIDBuffer`     : `array<vec2<u32>>`  (u64 heapID per slot; 0 = dead)
- `_Neighbors`        : `array<vec3<u32>>`  read [n0,n1,n2]=[LEFT,RIGHT,TWIN]
- `_NeighborsOut`     : `array<vec3<u32>>`  double-buffered write target (ping-pong like reference)
- `_BisectorData`     : `array<BisectorData>` struct {subdivisionPattern, indices:array<u32,3>, problematicNeighbor, bisectorState, flags, propagationID}
- `_Classification`   : `array<atomic<u32>>` [0]=SPLIT_COUNTER,[1]=SIMPLIFY_COUNTER,[2..]=lists
- `_Allocate`         : `array<atomic<u32>>` [0]=count, [1..]=ids
- `_Propagate`        : `array<atomic<u32>>` [0]=splitPropCount,[1]=simplifyPropCount,[2..]=ids
- `_Memory`           : `array<atomic<u32>>` [0]=bitAllocCursor (decode handle base), [1]=remaining-free-slots reservation
- pool buffers (binding 0 `pool_bitfield: array<atomic<u32>>`, binding 1 `pool_tree: array<u32>`) from ocbt_pool.wgsl, reused unchanged.

Note `_Memory[1]` mirrors reference `cbt_size() - bit_count_buffer()` = free slot count = `pool_freeCount()`; `_Memory[0]` mirrors the reference's running bit-reservation base used by AllocateElement (`InterlockedAdd(_MemoryBuffer[0], numSlots, firstBitIndex)`), where `firstBitIndex` indexes into the FREE-bit ordering decoded by `pool_decodeBitComplement(firstBitIndex+bitId)`. CRITICAL: this requires the pool_tree to have been reduced from the CURRENT bitfield BEFORE Allocate runs, and all allocations in one Allocate pass take DISJOINT complement handles `[firstBitIndex, firstBitIndex+numSlots)` against that frozen tree — exactly the reference's scheme.

## 3. Pass order (per refinement step), ported from mesh_updater.cpp

1. Reset (1 thread): clear counters, seed `_Memory[1]=pool_freeCount()`, `_Memory[0]=0`, indirect draw args.
2. Classify (over live slots): metric→state; append split candidates to `_Classification`, even-heapID merge candidates to the simplify list. (Phase-1 metric = deterministic placeholder, see §6.)
3. PrepareIndirect (1–2 threads): turn the split counter into indirect dispatch args.
4. Split (over split list): atomic memory reserve + BASE/twin-walk; OR-accumulate `subdivisionPattern`; append to `_Allocate`.
5. PrepareIndirect: allocate count → dispatch args.
6. Allocate (over `_Allocate` list): `pool_decodeBitComplement` to grab free slots, write into `bisectorData.indices`.
7. Copy `_Neighbors`→`_NeighborsOut` (ping-pong base) — or first thing in Bisect, each slot copies its own row if untouched.
8. Bisect (over `_Allocate` list): apply the 4 patterns; set heapIDs; write `_NeighborsOut` for self+siblings; set pool bits for new slots; append siblings needing fixup to `_Propagate`.
9. PrepareIndirect → PropagateBisect (over `_Propagate` split list): fix the `problematicNeighbor` row so reciprocity holds across the just-split diamond's far side.
10. (Merge passes — PrepareSimplify/Simplify/PropagateSimplify — are the dual; this piece ports the SPLIT half fully and leaves merge as the symmetric follow-on, since the task scope is Reset/Classify/Split/Allocate/Bisect/Propagate.)
11. Pool reduce (level-per-dispatch, reuse ocbt_pool_reduce.compute.wgsl) so the next frame's Allocate sees the updated free count.
12. BisectorElementIndexation (over live slots): compact live slots into draw-index buffer + indirect draw args.
13. Swap neighbor ping-pong index.

## 4. Why this stays watertight CONCURRENTLY (the crux)

The sequential oracle guarantees conformity by the LEPP walk (forceSplit follows the BASE chain to a same-level diamond, then bisectDiamond cross-links children). The concurrent engine reproduces the SAME final topology without a serial walk by three mechanisms:

(a) **subdivisionPattern OR-accumulation.** Each slot owns one `subdivisionPattern` u32. Split threads of different elements that all need to subdivide the SAME twin do `atomicOr(&data[twin].subdivisionPattern, FLAG, prev)`. Whoever observes `prev==0` "wins" the right to allocate for that element (reserves the slot, appends to _Allocate exactly once); the loser just contributes its bit. Because OR is commutative/idempotent, the final pattern is the union of all demands on that element regardless of thread order. The 4 legal unions are exactly CENTER(1), RIGHT_DOUBLE(1|2), LEFT_DOUBLE(1|4), TRIPLE(1|2|4) — BisectElement switches on the accumulated value. This is the concurrent encoding of "this element must split, and additionally its leg(s) were forced by a finer neighbor."

(b) **BASE/twin-walk inside SplitElement.** A single split thread, before reserving, walks up the longest-edge (twin) chain: if the twin is the SAME depth it's a terminal diamond → mark CENTER on both, done. If the twin is COARSER (already-subdivided relative to me / I'm on its leg) it needs a DOUBLE split and the walk continues up to ITS twin. This is the exact dual of the oracle's `while (level[tb] < level[t]) forceSplit(tb)` — but expressed as memory reservation + pattern flags rather than recursion. The early-out guards at the top of SplitElement (`if xNeighbors.z==currentID && state!=UNCHANGED return`) prevent two ends of a diamond from both driving the walk (the lower-id / non-twin-pointed-at end yields), so each diamond is split by exactly one driver — the concurrent analogue of the oracle's "if t already not a leaf, bail."

(c) **propagationID / problematicNeighbor fixup.** When a CENTER split creates sibling0, the new internal edge between currentID and its far neighbor (p_n1) may now point at the OLD parent on the neighbor's side. Bisect records `propagationID=currentID` (the parent before split) and `problematicNeighbor` on the sibling; PropagateBisectElement then reads the neighbor's (possibly also-split) row and rewrites whichever of its 3 entries still references `parentID` to reference `currentID`/sibling. Because every element that split records its parent id, the fixup is order-independent: each side reads the OTHER side's final pattern (already written by Bisect, separated by a UAV barrier) and patches deterministically. This restores neighbor reciprocity that the local Bisect couldn't set because it didn't own the neighbor's row. Net effect == the oracle's `replaceNeighbor(xL, t, t0)` + cross-link, but split across owner-writes + a propagate pass.

Watertightness proof sketch: after Bisect+Propagate, every live slot's 3 neighbors are reciprocal (Validate pass asserts: for each n in neighbors, currentID appears in n's neighbors). Reciprocity + same-level-diamond invariant (guaranteed by the OR pattern only ever producing the 4 conforming unions) ⇒ 0 T-junctions ⇒ identical decoded-vertex shared edges ⇒ watertight, matching the oracle.

## 5. Where atomics are REQUIRED (and which kind)

- `atomicAdd(_Classification[SPLIT_COUNTER],1)` / `[SIMPLIFY_COUNTER]` — claim a unique list slot. (return old → write id there)
- `atomicAdd(_Allocate[0],1)` — unique alloc-list slot.
- `atomicAdd(_Propagate[0]/[1],1)` — unique propagate-list slot.
- `atomicAdd(_Memory[1], -maxReq)` then conditional `atomicAdd(_Memory[1], +back)` — the reserve/refund of the free-slot budget. Prevents over-commit when many splits race for the last slots. The signed add is done as `atomicAdd` on a u32 reinterpreted (WGSL: use `atomicSub`/`atomicAdd` with the two-pass refund; we store the budget as a plain u32 count and atomicSub the request, checking the returned prior value).
- `atomicOr(&_BisectorData[id].subdivisionPattern, FLAG, prev)` — the OR-accumulation in (a). MUST be atomic because multiple split threads target the same twin's pattern. WGSL atomics live only on `atomic<u32>`, so `subdivisionPattern` is its OWN `array<atomic<u32>>` buffer (NOT a field inside a non-atomic struct — see pitfalls). The rest of BisectorData stays a plain struct buffer.
- `atomicAdd(_Memory[0], numSlots, firstBitIndex)` in Allocate — hands each allocating element a disjoint base into the complement-decode ordering.
- pool `pool_setBitAtomic` (atomicOr/atomicAnd) when Bisect marks new slots allocated / Simplify frees — concurrent single-bit masks, already atomic in ocbt_pool.wgsl.
- `atomicAdd(_IndirectDraw[0],3)` / `[4]` / `[8]` in Indexation — unique draw-slot reservation.

Non-atomic on purpose: `_HeapIDBuffer`, `_NeighborsOut`, `_BisectorData.indices/flags/propagationID/problematicNeighbor/bisectorState` — each is written by exactly ONE owning thread per pass (the element that owns that slot), reads happen in a later pass after a UAV barrier, so a plain read_write storage buffer is correct and faster. pool_tree is non-atomic (disjoint writes per reduce level).

## 6. Classify metric (Phase 1 placeholder)

Deterministic, no camera dependency needed for the topology cross-check: split if `u64_depth(heapID) - 3 < targetLevel` where `targetLevel` is a per-dispatch uniform; OR, for a spatial variant, decode the triangle centroid via ocbt_leb and split if `distance(centroid, focusPoint) < radius(depth)` (a shrinking-ball LOD). I use the distance-to-point form so the harness can drive a moving focus and exercise mixed split/merge regions (the hard case for conformity). `ClassifyBisector` returns >0 (BISECT) / 0 (UNCHANGED) / <0 (cull/too-small). Real screen-space-error metric is Phase 2 and slots into `classifyMetric()` only.


### bindings

group 0 (single bind group, reference order; pool bindings 0/1 are reused unchanged from ocbt_pool.wgsl):

  @binding(0)  pool_bitfield   : array<atomic<u32>>   (capacity/32 words)        [ocbt_pool.wgsl]
  @binding(1)  pool_tree       : array<u32>           (2*capacity words)         [ocbt_pool.wgsl]
  @binding(2)  _HeapID         : array<vec2<u32>>     (capacity * 8 bytes)  u64 heapID per slot; (0,0)=dead
  @binding(3)  _Neighbors      : array<vec3<u32>>     (capacity * 16 bytes, vec3 aligns to 16) order [n0=LEFT,n1=RIGHT,n2=TWIN]
  @binding(4)  _NeighborsOut   : array<vec3<u32>>     (capacity * 16 bytes) ping-pong write target
  @binding(5)  _SubdivPattern  : array<atomic<u32>>   (capacity * 4 bytes)  atomicOr accumulation
  @binding(6)  _Indices0       : array<u32>           (capacity * 4) BisectorData.indices[0]
  @binding(7)  _Indices1       : array<u32>           (capacity * 4) indices[1]
  @binding(8)  _Indices2       : array<u32>           (capacity * 4) indices[2]
  @binding(9)  _ProblemNb      : array<u32>           (capacity * 4)
  @binding(10) _State          : array<u32>           (capacity * 4)
  @binding(11) _Flags          : array<u32>           (capacity * 4)
  @binding(12) _PropID         : array<u32>           (capacity * 4)
  @binding(13) _Classify       : array<atomic<u32>>   ((2 + 2*capacity) * 4)  [0]=splitCnt [1]=simplifyCnt [2..]=split list, [2+total..]=simplify list
  @binding(14) _Allocate       : array<atomic<u32>>   ((1 + capacity) * 4)    [0]=count [1..]=ids
  @binding(15) _Propagate      : array<atomic<u32>>   ((2 + 2*capacity) * 4)  [0]=splitPropCnt [1]=simplifyPropCnt [2..]=ids
  @binding(16) _Memory         : array<atomic<u32>>   (2 * 4)  [0]=bit-alloc cursor (complement-decode base), [1]=free-slot budget
  @binding(17) _IndirectDraw   : array<atomic<u32>>   (9 * 4)  draw-arg quads + modified counter (reference layout)
  @binding(18) _DrawIndices    : array<u32>           (capacity * 4)
  @binding(19) _VisibleIndices : array<u32>           (capacity * 4)
  @binding(20) P               : uniform Params { liveCount:u32, totalSlots:u32, targetLevel:u32, pad:u32, focus:vec4<f32> }  (32 bytes, std140: scalars packed then vec4)

Babylon ComputeShader bindingsMapping: every name above → {group:0, binding:N}. Each pass compiled as its own ComputeShader with entry fn = pass name; reflection strips unused bindings per pass (e.g. Reset only touches _Memory/_Classify/_Allocate/_Propagate/_IndirectDraw — do NOT bind the others for that pass, exactly like the harness comment for decode).

Buffer creation flags (per gpu_cbt_kernel pattern): STORAGE for all; +WRITE (CopyDst) for any CPU-seeded (heapID seed, neighbors seed, pool bitfield, indirect args); +READ (CopySrc) for any read back in the cross-check (_HeapID, _Neighbors, pool_tree); +INDIRECT for the indirect-dispatch/draw arg buffers (_Allocate count region, _IndirectDraw, plus a dedicated dispatchArgs buffer written by a PrepareIndirect pass).


### codeDraft
```

// ============================================================================
// ocbt_engine.wgsl  — OCBT concurrent topology engine (WGSL port of
// references/.../update_utilities.hlsl). Composed AFTER:
//   poolWgslPreamble(capacity)   // OCBT_CAPACITY, OCBT_DEPTH consts
//   ocbt_u64.wgsl                // u64 = vec2<u32> helpers (u64_depth, u64_shl, ...)
//   ocbt_pool.wgsl               // pool_decodeBitComplement, pool_setBitAtomic, ...
// then ONE of the entry-point files below is appended (one @compute per pass).
// Neighbor buffer order = reference [n0=LEFT, n1=RIGHT, n2=TWIN]. baseDepth = 3.
// ============================================================================

const INVALID_PTR : u32 = 0xFFFFFFFFu;
const BASE_DEPTH  : u32 = 3u;            // octahedron faces are heap nodes 8..15

// ---- subdivision pattern flags (reference values) --------------------------
const NO_SPLIT      : u32 = 0x0u;
const CENTER_SPLIT  : u32 = 0x1u;
const RIGHT_SPLIT   : u32 = 0x2u;
const LEFT_SPLIT    : u32 = 0x4u;
const RIGHT_DOUBLE  : u32 = 0x3u;        // CENTER|RIGHT
const LEFT_DOUBLE   : u32 = 0x5u;        // CENTER|LEFT
const TRIPLE        : u32 = 0x7u;        // CENTER|RIGHT|LEFT

// ---- bisector states / flags ----------------------------------------------
const ST_UNCHANGED : u32 = 0u;
const ST_BISECT    : u32 = 1u;
const ST_SIMPLIFY  : u32 = 2u;
const ST_MERGED    : u32 = 3u;
const FLAG_VISIBLE  : u32 = 0x1u;
const FLAG_MODIFIED : u32 = 0x2u;

// ---- classification list offsets (reference) ------------------------------
const SPLIT_COUNTER          : u32 = 0u;
const SIMPLIFY_COUNTER       : u32 = 1u;
const CLASSIFY_COUNTER_OFFSET: u32 = 2u;

// ---- buffers (binding numbers come from the buffers piece; group 0) --------
// pool_bitfield @binding(0), pool_tree @binding(1)  -> from ocbt_pool.wgsl
@group(0) @binding(2) var<storage, read_write> _HeapID      : array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> _Neighbors   : array<vec3<u32>>;
@group(0) @binding(4) var<storage, read_write> _NeighborsOut: array<vec3<u32>>;
// BisectorData split so the atomic field is in its own atomic array:
@group(0) @binding(5) var<storage, read_write> _SubdivPattern : array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> _Indices0    : array<u32>; // indices[0]
@group(0) @binding(7) var<storage, read_write> _Indices1    : array<u32>; // indices[1]
@group(0) @binding(8) var<storage, read_write> _Indices2    : array<u32>; // indices[2]
@group(0) @binding(9)  var<storage, read_write> _ProblemNb  : array<u32>;
@group(0) @binding(10) var<storage, read_write> _State      : array<u32>;
@group(0) @binding(11) var<storage, read_write> _Flags      : array<u32>;
@group(0) @binding(12) var<storage, read_write> _PropID     : array<u32>;
@group(0) @binding(13) var<storage, read_write> _Classify   : array<atomic<u32>>;
@group(0) @binding(14) var<storage, read_write> _Allocate   : array<atomic<u32>>;
@group(0) @binding(15) var<storage, read_write> _Propagate  : array<atomic<u32>>;
@group(0) @binding(16) var<storage, read_write> _Memory     : array<atomic<u32>>;
@group(0) @binding(17) var<storage, read_write> _IndirectDraw : array<atomic<u32>>;
@group(0) @binding(18) var<storage, read_write> _DrawIndices  : array<u32>;
@group(0) @binding(19) var<storage, read_write> _VisibleIndices : array<u32>;

struct Params {
    liveCount : u32,
    totalSlots: u32,
    targetLevel : u32,      // Phase-1 metric
    pad : u32,
    focus : vec4<f32>,      // .xyz focus point on unit sphere, .w radius scale
};
@group(0) @binding(20) var<uniform> P : Params;

// ---- accessors mapping reference n0/n1/n2 ---------------------------------
fn nb_left (v : vec3<u32>) -> u32 { return v.x; }   // reference n0
fn nb_right(v : vec3<u32>) -> u32 { return v.y; }   // reference n1
fn nb_twin (v : vec3<u32>) -> u32 { return v.z; }   // reference n2 == World42 BASE

// heapID child math in u64
fn heap_mul2(h : vec2<u32>) -> vec2<u32> { return u64_shl(h, 1u); }
fn heap_2hp1(h : vec2<u32>) -> vec2<u32> { return u64_or(u64_shl(h,1u), u64_from_u32(1u)); }
fn heap_mul4(h : vec2<u32>) -> vec2<u32> { return u64_shl(h, 2u); }
fn heap_4hpk(h : vec2<u32>, k : u32) -> vec2<u32> { return u64_or(u64_shl(h,2u), u64_from_u32(k)); }
fn heap_is_zero(h : vec2<u32>) -> bool { return h.x == 0u && h.y == 0u; }

// ===========================================================================
// RESET  (dispatch 1 thread)
// ===========================================================================
@compute @workgroup_size(1)
fn Reset() {
    atomicStore(&_Memory[0], 0u);                       // bit-alloc cursor
    atomicStore(&_Memory[1], pool_freeCount());         // free-slot budget
    atomicStore(&_Classify[SPLIT_COUNTER], 0u);
    atomicStore(&_Classify[SIMPLIFY_COUNTER], 0u);
    atomicStore(&_Allocate[0], 0u);
    atomicStore(&_Propagate[0], 0u);
    atomicStore(&_Propagate[1], 0u);
    // indirect draw args: [0]=indexCount accum (start 0), [1]=instanceCount=1 ...
    atomicStore(&_IndirectDraw[0], 0u);
    atomicStore(&_IndirectDraw[1], 1u);
    atomicStore(&_IndirectDraw[4], 0u);
    atomicStore(&_IndirectDraw[5], 1u);
    atomicStore(&_IndirectDraw[8], 0u);
}

// ===========================================================================
// CLASSIFY  (one thread per live slot)
//   Phase-1 metric: deterministic distance-to-focus shrinking ball.
//   returns: >0 split, 0 unchanged, <0 cull/too-small
// ===========================================================================
fn classifyMetric(heap : vec2<u32>, depth : u32) -> i32 {
    let lebDepth = depth;                 // u64_depth already counts faces at 3
    // decode centroid lazily would need ocbt_eval_leb; Phase-1 uses pure depth
    // target so the cross-check is purely topological & camera-free:
    if (depth - BASE_DEPTH < P.targetLevel) { return 1; }   // wants finer
    if (depth - BASE_DEPTH > P.targetLevel) { return -1; }  // wants coarser
    return 0;                                                 // happy
}

@compute @workgroup_size(256)
fn Classify(@builtin(global_invocation_id) gid : vec3<u32>) {
    let id = gid.x;
    if (id >= P.totalSlots) { return; }
    let heap = _HeapID[id];
    if (heap_is_zero(heap)) { return; }          // dead slot
    let depth = u64_depth(heap);

    // reset per-frame fields (owner write, non-atomic)
    atomicStore(&_SubdivPattern[id], 0u);
    _State[id] = ST_UNCHANGED;
    _ProblemNb[id] = INVALID_PTR;
    _Flags[id] = FLAG_VISIBLE;

    let v = classifyMetric(heap, depth);
    if (v > 0) {
        _State[id] = ST_BISECT;
        let slot = atomicAdd(&_Classify[SPLIT_COUNTER], 1u);
        atomicStore(&_Classify[CLASSIFY_COUNTER_OFFSET + slot], id);
    }
    // merge candidate: coarser wanted AND not already at base depth
    if (depth != BASE_DEPTH && v < 0) {
        _State[id] = ST_SIMPLIFY;
        if (u64_bit(heap, 0u) == 0u) {           // only even heapIDs register
            let slot = atomicAdd(&_Classify[SIMPLIFY_COUNTER], 1u);
            atomicStore(&_Classify[CLASSIFY_COUNTER_OFFSET + P.totalSlots + slot], id);
        }
    }
}

// ===========================================================================
// SPLIT  (one thread per split-list entry)  — atomic reserve + twin-walk
// ===========================================================================
@compute @workgroup_size(256)
fn Split(@builtin(global_invocation_id) gid : vec3<u32>) {
    let listIdx = gid.x;
    if (listIdx >= atomicLoad(&_Classify[SPLIT_COUNTER])) { return; }
    var currentID = atomicLoad(&_Classify[CLASSIFY_COUNTER_OFFSET + listIdx]);

    let cN = _Neighbors[currentID];
    // yield if we are on the path of a neighbor that drives the diamond (n0)
    if (nb_left(cN) != INVALID_PTR) {
        let xN = _Neighbors[nb_left(cN)];
        if (nb_twin(xN) == currentID && _State[nb_left(cN)] != ST_UNCHANGED) { return; }
    }
    if (nb_right(cN) != INVALID_PTR) {
        let yN = _Neighbors[nb_right(cN)];
        if (nb_twin(yN) == currentID && _State[nb_right(cN)] != ST_UNCHANGED) { return; }
    }

    let heap = _HeapID[currentID];
    var currentDepth = u64_depth(heap);
    var maxReq : u32 = 2u * (currentDepth - BASE_DEPTH) - 1u;
    var twinID = nb_twin(cN);
    if (twinID == INVALID_PTR) {
        maxReq = 1u;
    } else if (nb_twin(_Neighbors[twinID]) == currentID) {
        maxReq = 2u;
    }

    // reserve budget; refund + bail if oversubscribed
    let prevBudget = atomicSub(&_Memory[1], maxReq);
    if (prevBudget < maxReq) {                    // not enough free slots
        atomicAdd(&_Memory[1], maxReq);
        return;
    }

    var usedMemory : u32 = 1u;
    let prevPat = atomicOr(&_SubdivPattern[currentID], CENTER_SPLIT);
    if (prevPat != 0u) {                          // someone else already drives us
        atomicAdd(&_Memory[1], maxReq);
        return;
    }
    let loc0 = atomicAdd(&_Allocate[0], 1u);
    atomicStore(&_Allocate[1u + loc0], currentID);

    // ---- BASE/twin-walk up the longest-edge chain ----
    var done = false;
    loop {
        if (done) { break; }
        if (twinID == INVALID_PTR) { break; }
        let nHeap = _HeapID[twinID];
        let nDepth = u64_depth(nHeap);
        let nN = _Neighbors[twinID];
        if (nDepth == currentDepth) {
            let p = atomicOr(&_SubdivPattern[twinID], CENTER_SPLIT);
            if (p == 0u) {
                let l = atomicAdd(&_Allocate[0], 1u);
                atomicStore(&_Allocate[1u + l], twinID);
                usedMemory = usedMemory + 1u;
            }
            done = true;
        } else {
            // twin is coarser: add the second leg split (right- or left-double)
            var p : u32;
            if (nb_left(nN) == currentID) {
                p = atomicOr(&_SubdivPattern[twinID], RIGHT_DOUBLE);
            } else { // nb_right(nN) == currentID
                p = atomicOr(&_SubdivPattern[twinID], LEFT_DOUBLE);
            }
            if (p != 0u) {
                usedMemory = usedMemory + 1u;
                done = true;
            } else {
                let l = atomicAdd(&_Allocate[0], 1u);
                atomicStore(&_Allocate[1u + l], twinID);
                usedMemory = usedMemory + 2u;
                currentID = twinID;
                currentDepth = nDepth;
                twinID = nb_twin(_Neighbors[currentID]);
            }
        }
    }
    // refund the slack
    if (maxReq > usedMemory) { atomicAdd(&_Memory[1], maxReq - usedMemory); }
}

// ===========================================================================
// ALLOCATE  (one thread per _Allocate entry) — pool_decodeBitComplement
// ===========================================================================
@compute @workgroup_size(256)
fn Allocate(@builtin(global_invocation_id) gid : vec3<u32>) {
    let listIdx = gid.x;
    if (listIdx >= atomicLoad(&_Allocate[0])) { return; }
    let currentID = atomicLoad(&_Allocate[1u + listIdx]);

    let pat = atomicLoad(&_SubdivPattern[currentID]);
    if (pat == 0u) { return; }
    let numSlots = countOneBits(pat);

    // disjoint base into the FREE-bit ordering of the (frozen, reduced) tree
    let firstBit = atomicAdd(&_Memory[0], numSlots);
    if (numSlots >= 1u) { _Indices0[currentID] = pool_decodeBitComplement(firstBit + 0u); }
    if (numSlots >= 2u) { _Indices1[currentID] = pool_decodeBitComplement(firstBit + 1u); }
    if (numSlots >= 3u) { _Indices2[currentID] = pool_decodeBitComplement(firstBit + 2u); }
}

// ===========================================================================
// BISECT helpers + CENTER pattern (full) + skeleton of double/triple
// ===========================================================================
const SIB0 : u32 = 0u; const SIB1 : u32 = 1u; const SIB2 : u32 = 2u;

fn idxN(id : u32, k : u32) -> u32 {
    if (k == 0u) { return _Indices0[id]; }
    if (k == 1u) { return _Indices1[id]; }
    return _Indices2[id];
}

// Port of evaluate_neighbors: given a neighbor that may have subdivided, return
// the two child slots facing `currentID`.  resX/resY via a small struct.
struct Eval { x : u32, y : u32 };
fn evaluate_neighbors(currentID : u32, bisectorID : u32) -> Eval {
    var r : Eval; r.x = INVALID_PTR; r.y = INVALID_PTR;
    let pat = atomicLoad(&_SubdivPattern[bisectorID]);
    let nN = _Neighbors[bisectorID];
    if (pat == CENTER_SPLIT) {
        r.x = idxN(bisectorID, SIB0); r.y = bisectorID;
    } else if (pat == RIGHT_DOUBLE) {
        if (nb_left(nN) == currentID) { r.x = idxN(bisectorID, SIB1); r.y = bisectorID; }
        else { r.x = idxN(bisectorID, SIB0); r.y = idxN(bisectorID, SIB1); }
    } else if (pat == LEFT_DOUBLE) {
        if (nb_right(nN) == currentID) { r.x = idxN(bisectorID, SIB1); r.y = idxN(bisectorID, SIB0); }
        else { r.x = idxN(bisectorID, SIB0); r.y = bisectorID; }
    } else { // TRIPLE
        if (nb_left(nN) == currentID) { r.x = idxN(bisectorID, SIB1); r.y = bisectorID; }
        else if (nb_right(nN) == currentID) { r.x = idxN(bisectorID, SIB2); r.y = idxN(bisectorID, SIB0); }
        else { r.x = idxN(bisectorID, SIB0); r.y = idxN(bisectorID, SIB1); }
    }
    return r;
}

@compute @workgroup_size(256)
fn Bisect(@builtin(global_invocation_id) gid : vec3<u32>) {
    let listIdx = gid.x;
    if (listIdx >= atomicLoad(&_Allocate[0])) { return; }
    let currentID = atomicLoad(&_Allocate[1u + listIdx]);

    let baseHeap = _HeapID[currentID];
    let pat = atomicLoad(&_SubdivPattern[currentID]);
    if (heap_is_zero(baseHeap) || pat == NO_SPLIT) { return; }

    let cN = _Neighbors[currentID];
    let p_n0 = nb_left(cN);   // reference n0
    let p_n1 = nb_right(cN);  // reference n1
    let p_n2 = nb_twin(cN);   // reference n2 (twin / BASE)
    let s0 = idxN(currentID, SIB0);
    let s1 = idxN(currentID, SIB1);
    let s2 = idxN(currentID, SIB2);

    if (pat == CENTER_SPLIT) {
        var ev : Eval; ev.x = INVALID_PTR; ev.y = INVALID_PTR;
        if (p_n2 != INVALID_PTR) { ev = evaluate_neighbors(currentID, p_n2); }

        _HeapID[currentID] = heap_mul2(baseHeap);     // 2h
        _HeapID[s0]        = heap_2hp1(baseHeap);     // 2h+1

        _NeighborsOut[currentID] = vec3<u32>(s0, ev.x, p_n0);
        _NeighborsOut[s0]        = vec3<u32>(ev.y, currentID, p_n1);

        // parent bookkeeping for the propagate fixup
        _PropID[currentID] = currentID; _ProblemNb[currentID] = INVALID_PTR;
        _Flags[currentID]  = FLAG_VISIBLE | FLAG_MODIFIED;
        _PropID[s0] = currentID; _ProblemNb[s0] = p_n1;
        _Flags[s0]  = FLAG_VISIBLE | FLAG_MODIFIED;
        _State[s0]  = ST_BISECT;
        _HeapID[s0] = heap_2hp1(baseHeap); // (already set; explicit for clarity)

        let loc = atomicAdd(&_Propagate[0], 1u);
        atomicStore(&_Propagate[2u + loc], s0);
    }
    else if (pat == RIGHT_DOUBLE) {
        // ---- SKELETON (full body mirrors HLSL RIGHT_DOUBLE_SPLIT) ----
        // ev0 = evaluate_neighbors(currentID, p_n0);
        // ev1 = (p_n2!=INV) ? evaluate_neighbors(currentID, p_n2) : INV;
        // heap: currentID=4h, s0=2h+1, s1=4h+1
        // out[currentID] = (s1, ev0.x, s0)
        // out[s0]        = (ev1.y, currentID, p_n1)
        // out[s1]        = (ev0.y, currentID, ev1.x)
        // ProblemNb[s0]=p_n1; PropID on all = currentID; flags VISIBLE|MODIFIED
        // propagate s0
    }
    else if (pat == LEFT_DOUBLE) {
        // ---- SKELETON (mirrors HLSL LEFT_DOUBLE_SPLIT) ----
        // ev0 = evaluate_neighbors(currentID, p_n1);
        // ev1 = (p_n2!=INV) ? evaluate_neighbors(currentID, p_n2) : INV;
        // heap: currentID=2h, s0=4h+2, s1=4h+3
        // out[currentID]=(s1, ev1.x, p_n0)
        // out[s0]       =(s1, ev0.x, ev1.y)
        // out[s1]       =(ev0.y, s0, currentID)
        // PropID=currentID on all; no propagate entry (HLSL emits none here)
    }
    else { // TRIPLE
        // ---- SKELETON (mirrors HLSL TRIPLE_SPLIT) ----
        // ev0=evaluate_neighbors(currentID,p_n0); ev1=..(p_n1); ev2=(p_n2!=INV)?..:INV
        // heap: currentID=4h, s0=4h+2, s1=4h+1, s2=4h+3
        // out[currentID]=(s1, ev0.x, s2)
        // out[s0]       =(s2, ev1.x, ev2.y)
        // out[s1]       =(ev0.y, currentID, ev2.x)
        // out[s2]       =(ev1.y, s0, currentID)
        // PropID=currentID on all; no propagate entry
    }

    // mark every newly-used pool slot allocated
    let n = countOneBits(pat);
    for (var k : u32 = 0u; k < n; k = k + 1u) {
        pool_setBitAtomic(idxN(currentID, k), true);
    }
}

// ===========================================================================
// PROPAGATE BISECT  (one thread per _Propagate[0] entry) — reciprocity fixup
// ===========================================================================
@compute @workgroup_size(256)
fn PropagateBisect(@builtin(global_invocation_id) gid : vec3<u32>) {
    let listIdx = gid.x;
    if (listIdx >= atomicLoad(&_Propagate[0])) { return; }
    let currentID = atomicLoad(&_Propagate[2u + listIdx]);

    let parentID = _PropID[currentID];
    let problem  = _ProblemNb[currentID];
    if (problem == INVALID_PTR) { return; }

    let tPat = atomicLoad(&_SubdivPattern[problem]);
    let tN   = _Neighbors[problem];   // NOTE reads the OLD (current) neighbor buffer
    let target = problem;
    let sib1 = _Indices1[problem];

    if (tPat == NO_SPLIT) {
        if (nb_left(tN)  == parentID) { _Neighbors[target].x = currentID; }
        if (nb_right(tN) == parentID) { _Neighbors[target].y = currentID; }
        if (nb_twin(tN)  == parentID) { _Neighbors[target].z = currentID; }
    } else if (tPat == CENTER_SPLIT) {
        if (_Neighbors[target].z == parentID) { _Neighbors[target].z = currentID; }
        let tp = _PropID[target];
        if (_Neighbors[tp].z == parentID) { _Neighbors[tp].z = currentID; }
    } else if (tPat == RIGHT_DOUBLE) {
        _Neighbors[sib1].z = currentID;
    } else if (tPat == LEFT_DOUBLE) {
        _Neighbors[target].z = currentID;
    }

    _ProblemNb[currentID] = INVALID_PTR;
    _State[currentID] = ST_UNCHANGED;
}

// ===========================================================================
// BISECTOR ELEMENT INDEXATION (one thread per live slot) — draw compaction
// ===========================================================================
@compute @workgroup_size(256)
fn BisectorIndexation(@builtin(global_invocation_id) gid : vec3<u32>) {
    let id = gid.x;
    if (id >= P.totalSlots) { return; }
    let heap = _HeapID[id];
    if (heap_is_zero(heap)) { return; }       // deallocated

    let slot = atomicAdd(&_IndirectDraw[0], 3u);
    _DrawIndices[slot / 3u] = id;

    let flags = _Flags[id];
    if ((flags & FLAG_VISIBLE) == 0u) { return; }
    let vslot = atomicAdd(&_IndirectDraw[4], 3u);
    _VisibleIndices[vslot / 3u] = id;
}

```

### pitfalls
- WGSL atomics ONLY on atomic<u32>. The reference packs subdivisionPattern inside the BisectorData struct and does InterlockedOr on a struct field. WGSL CANNOT atomicOr a field of a non-atomic struct, and you cannot have a partially-atomic struct in a storage array. FIX (used in draft): hoist subdivisionPattern into its own array<atomic<u32>> buffer (_SubdivPattern); keep the rest of BisectorData as separate plain arrays (or one plain struct). All other BisectorData fields are single-owner-per-pass so non-atomic is correct.
- No u64: heapID is vec2<u32>; ALL heap compares/shifts go through ocbt_u64.wgsl. u64_depth = firstLeadingBit (NO +1) — faces at depth 3. Do NOT port the reference's HeapIDDepth=firstbithigh+1; baseDepth is 3, not 0.
- atomicSub on the free-slot budget: the reference does InterlockedAdd(_Memory[1], -maxReq). WGSL atomicAdd takes u32 (no negative literal). Use atomicSub(&_Memory[1], maxReq) and test the RETURNED prior value (prevBudget < maxReq → refund with atomicAdd). Underflow wraps mod 2^32, but the prevBudget<maxReq guard catches it before any use. The refund must use the SAME amount that was subtracted.
- vec3<u32> in a storage array is laid out with 16-byte stride (vec3 aligns/sizes to 16 in WGSL). The TS-side typed-array packing for _Neighbors / _NeighborsOut MUST use stride 4 u32 per element (3 used + 1 pad), or use vec4<u32>. Mismatched stride silently corrupts neighbor reads. (gpu_cbt uses scalar arrays to dodge this; here vec3 is convenient but watch the 16B stride.)
- _NeighborsOut is a PING-PONG: Bisect writes the new topology to _NeighborsOut while reading the OLD _Neighbors; PropagateBisect then reads/patches. The reference copies current→next before Bisect and swaps indices after. In Babylon there is no in-pass buffer copy in WGSL — do the swap on the TS side by re-pointing the bindingsMapping each frame (two StorageBuffers, alternate which is _Neighbors vs _NeighborsOut), exactly like mesh_updater's currentNeighborsBufferIdx. PropagateBisect in the reference writes _NeighborsBuffer (the NEW one, = nextNeighborsBuffer after swap) — bind it to the post-swap buffer.
- Allocate correctness depends on pool_tree being REDUCED from the current bitfield BEFORE Allocate runs, AND no bit being set during Allocate. The draft sets bits in Bisect (after Allocate), and uses a per-pass atomic cursor (_Memory[0]) so all complement handles in one Allocate pass are disjoint against the frozen tree — matching the reference. Do NOT call pool_setBitAtomic inside Allocate.
- ComputeShader dispatch is a no-op until isReady(); use whenReady() polling (gpu_cbt_kernel pattern). For the cross-check harness with no render loop, readback MUST use StorageBuffer.read(0,undefined,undefined,true) (noDelay=true forces flush+submit), as in ocbt_pool_gpu_harness.
- Each same-submit pass that updates a per-level/per-pass UBO needs its OWN UniformBuffer instance — Babylon coalesces writeBuffer to the last value before submit (see gpu_cbt_kernel levelParams comment). The Params UBO is written once per refinement step so a single instance is fine, but the PrepareIndirect → indirect-args buffers must be real StorageBuffers with INDIRECT flag, not UBOs.
- Indirect dispatch group counts come from atomic counters (_Classify[SPLIT_COUNTER], _Allocate[0], _Propagate[0]). A PrepareIndirect compute pass (1 thread) must convert count→ceil(count/256) into a dispatchArgs StorageBuffer(INDIRECT) BEFORE the next pass; you cannot read an atomic counter into dispatch group count on the CPU without a stall. Mirror mesh_updater's PrepareIndirect kernel.
- Reading an atomic counter for a loop bound (e.g. `if listIdx >= atomicLoad(&_Classify[SPLIT_COUNTER])`) is fine, but the value must be FINAL — ensure a UAV barrier / separate dispatch between the pass that increments it (Classify) and the pass that reads it (Split). Babylon inserts barriers between separate ComputeShader.dispatch calls on the same buffers; do not fuse passes.
- The cross-check compares INVARIANTS not slot indices: (1) live heapID multiset equal (sort both); (2) neighbor reciprocity — for each live slot, each non-INVALID neighbor lists this slot back (remap oracle [BASE,LEFT,RIGHT]→[n0,n1,n2] first); (3) zero T-junctions via decoded verts (ocbt_leb on both sides, shared-edge endpoints match within 1e-6). Concurrent allocation order differs from the sequential mirror, so pool slot ids will NOT match — never compare them.
- countbits→countOneBits in WGSL (HLSL spelling differs). firstbithigh→firstLeadingBit (already wrapped in ocbt_u64). InterlockedAdd(buf,v,prev)→let prev=atomicAdd(&buf,v). InterlockedOr similarly returns the prior value.


## DRAFT: draft:kernel

### design
## OcbtTopologyKernel — orchestration class

### Role
GPU twin of `OcbtTopology` (the sequential CPU oracle). Owns the bisector pool (bitfield + sum-tree) and the per-slot SoA, builds every ComputeShader pass, uploads the octahedron seed (slots 0..7), polls whenReady, and runs the per-frame concurrent refine/merge sequence in the EXACT order of `mesh_updater.cpp`. Mirrors `GpuCbtKernel` structure (composeCompute + StorageBuffer + UniformBuffer + indirect dispatch + whenReady) and reuses `OcbtPoolGpuHarness`'s pool reduce/decode driver pattern (per-level UBOs, 2D dispatch spill, StorageBuffer.read noDelay). Correctness verified against the oracle by INVARIANTS (live heapID multiset, neighbor reciprocity, 0-T-junction via decoded verts), never pool indices.

### Convention bridge (LOCKED)
Oracle neighbor order is [BASE=0, LEFT=1, RIGHT=2], BASE = hypotenuse/split-edge twin. Reference HLSL uint3 (n0,n1,n2) has n2 = twin. Mapping: oracle BASE <-> ref n2; oracle LEFT <-> ref n0; oracle RIGHT <-> ref n1. Because we port the reference's Split/Bisect/PropagateBisect verbatim, the GPU neighbor buffer is stored in REFERENCE order per slot: n0=LEFT, n1=RIGHT, n2=BASE(twin). INVALID_POINTER = 0xFFFFFFFFu (oracle's -1). The cross-check remaps ref->oracle when comparing reciprocity against OcbtTopology.

### Stride/representation decisions
- Neighbors: store as FLAT array<u32>, 4 u32/slot (n0,n1,n2,pad) to avoid the array<vec3<u32>> 16-byte stride trap; makes the ping-pong copy and readback plain element indexing.
- heapID: 2 u32/slot (vec2 u64 lo/hi via ocbt_u64). Child id math uses u64_shl/u64_or (no native multiply).
- bisData: 8 u32/slot {pattern, indices[3], problematicNeighbor, state, flags, propagationID}. Vertices NOT stored (vert-free; decoded from heapID via eval-leb), matching the oracle note that geometry is decodable from heapID.

### Pool dependency (key correctness point)
pool_decodeBitComplement (used by Allocate) requires a freshly reduced pool_tree. So a pool REDUCE must run before frame 0 (after seed) and again at the END of every frame after Simplify frees bits, so next frame's Allocate/count/readback are valid. Reset seeds MemoryBuffer[0]=0 (alloc cursor) and MemoryBuffer[1]=pool_freeCount() (reservation counter from pool_tree[1]). Allocate reserves slots by cursor offset over decode_bit_complement of the START-of-frame tree; bits are only set later in Bisect — so the drafted ordering (Allocate before any set_bit) preserves the reference's invariant.

### Per-frame dispatch sequence (exact mesh_updater.cpp order)
0. LiveDispatchArgs (1 thread): pool_count() -> liveDispatchArgs for Classify/Indexation.
1. Reset (1 group): zero ClassificationBuffer[SPLIT,SIMPLIFY], AllocateBuffer[0], PropagateBuffer[0..1], SimplificationBuffer[0], IndirectDraw header; MemoryBuffer[0]=0, MemoryBuffer[1]=freeCount.
2. Classify (indirect/live): decode heapID->depth, run ClassifyBisector metric (camLocal/focal/thresholds), append BISECT to split list (atomicAdd SPLIT_COUNTER) and SIMPLIFY (even-heapID rule) to simplify list; write bisData state.
3. PrepareIndirect "split" (selects SPLIT_COUNTER -> indirectArgs).
4. Split (indirect): BASE/twin chain walk + atomicAdd memory reservation + atomicOr subdivisionPattern (CENTER on self; CENTER/DOUBLE up the twin chain) + append AllocateBuffer.
5. PrepareIndirect "allocate" (AllocateBuffer[0]).
6. Allocate (indirect): countbits(pattern) slots via atomicAdd(MemoryBuffer[0]) then pool_decodeBitComplement -> bisData.indices[k].
7. COPY neighbors current->next (compute copy pass; no Babylon buffer-copy API).
8. Bisect (indirect): 4 patterns CENTER/RIGHT_DOUBLE/LEFT_DOUBLE/TRIPLE; set child heapIDs, evaluate_neighbors cross-links, write neighborsNext, set pool bits on new children, push PropagateBuffer.
9. PrepareIndirect "propagate bisect" (PropagateBuffer[0]).
10. PropagateBisect (indirect): fix problematicNeighbor back-refs in the NEW (next) buffer.
11. Optional Simplify block (gated by enableSimplify): PrepareSimplify -> PrepareIndirect -> Simplify (collapse diamond, heapID/2 & 0, free pair bits via set_bit_atomic(false), push PropagateBuffer[1]) -> PrepareIndirect -> PropagateSimplify. (Sketched; same pattern.)
12. Pool REDUCE (leaf prepass level=DEPTH, then DEPTH-1..0): rebuild pool_tree from updated bitfield.
13. Swap ping-pong parity (Bisect wrote the OTHER buffer; it becomes current).
14. Indexation (indirect/live): compact live slots -> bisectorIndices + draw indirect args (3 verts/leaf).
15. Readback live count (pool_tree[1]) for HUD (non-forced read over render loop).

### Indirect dispatch usage
Live-count-scaled passes (Classify, Indexation) dispatch indirectly from liveDispatchArgs (built from pool_count like cbt_dispatch_args). Work-list passes (Split/Allocate/Bisect/PropagateBisect/Simplify/PropagateSimplify) dispatch indirectly from indirectArgs, built by a single shared PrepareIndirect pass (mirrors the reference reusing one PrepareIndirectCS) selected by a prepUbo mode. PrepareIndirect itself is a fixed 1-thread dispatch. Pool reduce stays DIRECT per level (count=2^level is data-independent, per GpuCbtKernel.runReduction).

### Ping-pong handling (DECISION)
Babylon bind groups are fixed at setStorageBuffer time, so neighbor-touching passes are PRE-BUILT in AB (read A write B) and BA (read B write A) variants; runFrame picks by parity. Same "pre-build per state" trick GpuCbtKernel uses for per-level UBOs. The copy pass and PropagateBisect/Indexation (operate on the live/next buffer) also have both variants. Avoids per-frame re-binding races.

### Cross-check harness (dev-only, twin of ocbt_pool_gpu_test_main)
Drive N refine/merge steps on BOTH OcbtTopology (oracle) and the GPU kernel with the SAME classify decisions, read back heapID+neighbors+bitfield, assert: (a) live heapID multiset equal (sorted), (b) neighbor reciprocity per live edge (after ref->oracle lane remap), (c) zero T-junctions: decode each live heapID via lebDecode and check shared edges have no hanging midpoint. Pool slot indices NOT compared.

### bindings
All buffers in @group(0). Stable binding-slot map (each pass binds ONLY the slots it references; Babylon reflection strips unused ones and binding an absent slot invalidates the whole group):

- 0  pool_bitfield : array<atomic<u32>>  capacity/32 words. (allocated bit per slot)
- 1  pool_tree     : array<u32>          2*capacity. (sum-tree; decode_bit_complement)
- 2  heapID        : array<u32>          2/slot (u64 lo,hi) = 2*capacity u32.
- 3  nbCurrent / nbLive : array<u32>     4/slot (n0=LEFT,n1=RIGHT,n2=BASE,pad) = 4*capacity u32. (read buffer this parity)
- 4  nbNext        : array<u32>          4/slot. (write buffer = ping-pong twin)
- 5  bisData       : array<u32>          8/slot {0=pattern,1..3=indices,4=problematic,5=state,6=flags,7=propagation}. Declared array<atomic<u32>> in Split/Bisect (atomicOr on pattern lane), plain array<u32> elsewhere.
- 6  classification: array<u32>          [0]=SPLIT_COUNTER,[1]=SIMPLIFY_COUNTER,[2..)=split ids, [2+totalElems..)=simplify ids. atomic in Classify.
- 7  simplifyBuf   : array<u32>          [0]=count,[1..]=ids.
- 8  allocateBuf   : array<u32>          [0]=count,[1..]=ids. atomic in Split.
- 9  propagateBuf  : array<u32>          [0]=bisectCount,[1]=simplifyCount,[2..]=ids. atomic in Bisect/Simplify.
- 10 memoryBuf     : array<atomic<i32>>  [0]=alloc cursor,[1]=free-count reservation (goes negative transiently in Split rollback).
- 11 indirectArgs / liveDispatchArgs : array<u32> [gx,gy,1,pad] for dispatchIndirect.
- 12 indexation    : array<u32>          draw header (8 u32) + compacted per-leaf ids.
- 13 frame / prep / reduceParams : var<uniform> vec4 small UBO (one per pass; never two UBOs in one pass).

Creation flags: all SoA/work buffers STORAGE|READ|WRITE (READ=readback, WRITE because Babylon zero-inits via writeBuffer needing CopyDst). indirectArgs & liveDispatchArgs add INDIRECT. poolBitfield/poolTree do NOT need INDIRECT.

WGSL compose per pass: poolWgslPreamble(capacity) (emits OCBT_CAPACITY, OCBT_DEPTH) + `const OCBT_MAX_DEPTH:u32` + ocbt_u64.wgsl + ocbt_pool.wgsl + ocbt_topo_common.wgsl (INVALID_POINTER, ref<->oracle lane consts N_LEFT/N_RIGHT/N_BASE, BisectorData accessors, HeapIDDepth=u64_depth, ClassifyBisector metric, eval-leb vertex decode) + the pass file. reduce/liveDisp compose only preamble+pool(+reduce/disp) — no u64/topo needed.

Pre-built variant arrays (indexed by parity): classify[2], split[2], copy[2], bisect[2], propBisect[2], index[2]. parity 0 => current=nbA (read A / write B); parity 1 => current=nbB. propBisect[k]/index operate on the buffer Bisect wrote (next), so their binding maps nbLive to nbB for k=0.

Pre-built UBO arrays: reduceUbo[0..depth] (one per reduce level, avoids same-submit coalescing), prepUbo[0..4] (modes: 0 split,1 alloc,2 propBisect,3 simplify,4 propSimplify).

### codeDraft
```
// src/systems/lod/cbt/ocbt/ocbt_topology_kernel.ts  (orchestration class draft)
import {
    ComputeShader, Constants, StorageBuffer, UniformBuffer, type WebGPUEngine
} from '@babylonjs/core';
import ocbtU64Wgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_u64.wgsl';
import ocbtPoolWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_pool.wgsl';
import ocbtPoolReduceWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_pool_reduce.compute.wgsl';
import topoCommonWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_common.wgsl';
import topoResetWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_reset.compute.wgsl';
import topoClassifyWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_classify.compute.wgsl';
import topoPrepWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_prepare_indirect.compute.wgsl';
import topoSplitWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_split.compute.wgsl';
import topoAllocWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_allocate.compute.wgsl';
import topoCopyWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_copy_neighbors.compute.wgsl';
import topoBisectWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_bisect.compute.wgsl';
import topoPropWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_propagate_bisect.compute.wgsl';
import topoIndexWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_indexation.compute.wgsl';
import topoDispWgsl from '../../../../assets/shaders/cbt/ocbt/ocbt_topo_dispatch_args.compute.wgsl';
import { poolLayout, poolWgslPreamble } from './ocbt_buffers';
import { log2PowerOfTwo, OCBT_DEFAULT_CAPACITY } from './ocbt_pool';
import { u64 as mkU64 } from './ocbt_u64';

const WG = 256, MAX_DIM = 65535, INVALID = 0xffffffff;
const N_LEFT = 0, N_RIGHT = 1, N_BASE = 2, NB_STRIDE = 4, HEAP_STRIDE = 2, BIS_STRIDE = 8;
// Oracle [BASE,LEFT,RIGHT] root neighbors (mirror of ocbt_topology.ts ROOT_NEIGHBORS).
const ROOT_NB: ReadonlyArray<readonly [number, number, number]> = [
    [4,3,1],[5,0,2],[6,1,3],[7,2,0],[0,7,5],[1,4,6],[2,5,7],[3,6,4]];

function grid2D(g: number): [number, number] {
    g = Math.max(1, g); const gy = Math.ceil(g / MAX_DIM); return [Math.ceil(g / gy), gy];
}

export type OcbtTopoFrameParams = {
    camLocal: [number, number, number]; radius: number; focal: number;
    splitThreshold: number; mergeThreshold: number; enableSimplify: boolean;
    cullBackface?: boolean; cullMinDot?: number;
};

function compose(cap: number, maxDepth: number, ...parts: string[]): string {
    return poolWgslPreamble(cap) + `const OCBT_MAX_DEPTH:u32=${maxDepth}u;\n`
        + ocbtU64Wgsl + '\n' + ocbtPoolWgsl + '\n' + topoCommonWgsl + '\n' + parts.join('\n');
}

export class OcbtTopologyKernel {
    readonly capacity: number; readonly depth: number; readonly maxDepth: number;
    readonly poolBitfield: StorageBuffer; readonly poolTree: StorageBuffer;
    readonly heapID: StorageBuffer;
    private readonly nbA: StorageBuffer; private readonly nbB: StorageBuffer;
    private readonly bisData: StorageBuffer; private readonly classification: StorageBuffer;
    private readonly allocateBuf: StorageBuffer; private readonly propagateBuf: StorageBuffer;
    private readonly simplifyBuf: StorageBuffer; private readonly memoryBuf: StorageBuffer;
    private readonly indirectArgs: StorageBuffer; private readonly liveArgs: StorageBuffer;
    private readonly indexation: StorageBuffer;
    private readonly engine: WebGPUEngine; private readonly key: string;
    private reset!: ComputeShader; private prep!: ComputeShader;
    private alloc!: ComputeShader; private reduce!: ComputeShader; private liveDisp!: ComputeShader;
    private classify!: [ComputeShader, ComputeShader]; private split!: [ComputeShader, ComputeShader];
    private copy!: [ComputeShader, ComputeShader]; private bisect!: [ComputeShader, ComputeShader];
    private propBisect!: [ComputeShader, ComputeShader]; private index!: [ComputeShader, ComputeShader];
    private readonly reduceUbo: UniformBuffer[] = []; private readonly prepUbo: UniformBuffer[] = [];
    private readonly frameUbo: UniformBuffer; private parity = 0;

    constructor(engine: WebGPUEngine, key: string, maxDepth: number, capacity = OCBT_DEFAULT_CAPACITY) {
        this.engine = engine; this.key = key; this.maxDepth = maxDepth;
        this.capacity = capacity; this.depth = log2PowerOfTwo(capacity);
        const L = poolLayout(capacity);
        const SRW = Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READ | Constants.BUFFER_CREATIONFLAG_WRITE;
        const SRWI = SRW | Constants.BUFFER_CREATIONFLAG_INDIRECT;
        const mk = (b: number, f: number, n: string) => new StorageBuffer(engine, b, f, `${n}_${key}`);
        this.poolBitfield = mk(L.bitfieldBytes, SRW, 'bf'); this.poolTree = mk(L.treeBytes, SRW, 'tree');
        this.heapID = mk(capacity * HEAP_STRIDE * 4, SRW, 'heap');
        this.nbA = mk(capacity * NB_STRIDE * 4, SRW, 'nbA'); this.nbB = mk(capacity * NB_STRIDE * 4, SRW, 'nbB');
        this.bisData = mk(capacity * BIS_STRIDE * 4, SRW, 'bis');
        this.classification = mk((2 + 2 * capacity) * 4, SRW, 'class');
        this.allocateBuf = mk((1 + capacity) * 4, SRW, 'alloc');
        this.propagateBuf = mk((2 + 2 * capacity) * 4, SRW, 'prop');
        this.simplifyBuf = mk((1 + capacity) * 4, SRW, 'simpl');
        this.memoryBuf = mk(2 * 4, SRW, 'mem');
        this.indirectArgs = mk(16, SRWI, 'ind'); this.liveArgs = mk(16, SRWI, 'live');
        this.indexation = mk((8 + capacity) * 4, SRW, 'index');
        this.frameUbo = new UniformBuffer(engine, undefined, undefined, `frame_${key}`);
        this.frameUbo.addUniform('camLocalRadius', 4); this.frameUbo.addUniform('thresholds', 4);
        this.frameUbo.addUniform('ints', 4); this.frameUbo.update();
        this.build();
        for (let lvl = 0; lvl <= this.depth; lvl++) {
            const u = new UniformBuffer(engine, undefined, undefined, `red_${lvl}_${key}`);
            u.addUniform('data', 4); u.updateInt4('data', lvl, 0, 0, 0); u.update(); this.reduceUbo[lvl] = u;
        }
        for (let m = 0; m <= 4; m++) { // 0 split,1 alloc,2 propBisect,3 simplify,4 propSimplify
            const u = new UniformBuffer(engine, undefined, undefined, `prep_${m}_${key}`);
            u.addUniform('data', 4); u.updateInt4('data', m, 0, 0, 0); u.update(); this.prepUbo[m] = u;
        }
    }

    private cs(name: string, src: string, bindings: Record<string, { group: number; binding: number }>) {
        const c = new ComputeShader(`${name}_${this.key}`, this.engine, { computeSource: src }, { bindingsMapping: bindings });
        c.onError = (_e, errs) => console.error(`[OcbtTopologyKernel] ${name}:\n${errs}`); return c;
    }

    private build(): void {
        const C = this.capacity, D = this.maxDepth;
        // Each pass binds ONLY the buffers it references (reflection strips unused -> binding absent slot invalidates group).
        this.reset = this.cs('reset', compose(C, D, topoResetWgsl), {
            pool_tree: { group: 0, binding: 1 }, memoryBuf: { group: 0, binding: 10 },
            classification: { group: 0, binding: 6 }, allocateBuf: { group: 0, binding: 8 },
            propagateBuf: { group: 0, binding: 9 }, simplifyBuf: { group: 0, binding: 7 },
            indexation: { group: 0, binding: 12 } });
        this.reset.setStorageBuffer('pool_tree', this.poolTree);
        this.reset.setStorageBuffer('memoryBuf', this.memoryBuf);
        this.reset.setStorageBuffer('classification', this.classification);
        this.reset.setStorageBuffer('allocateBuf', this.allocateBuf);
        this.reset.setStorageBuffer('propagateBuf', this.propagateBuf);
        this.reset.setStorageBuffer('simplifyBuf', this.simplifyBuf);
        this.reset.setStorageBuffer('indexation', this.indexation);

        const mkClassify = (cur: StorageBuffer) => {
            const c = this.cs('classify', compose(C, D, topoClassifyWgsl), {
                heapID: { group: 0, binding: 2 }, nbCurrent: { group: 0, binding: 3 },
                bisData: { group: 0, binding: 5 }, classification: { group: 0, binding: 6 }, frame: { group: 0, binding: 13 } });
            c.setStorageBuffer('heapID', this.heapID); c.setStorageBuffer('nbCurrent', cur);
            c.setStorageBuffer('bisData', this.bisData); c.setStorageBuffer('classification', this.classification);
            c.setUniformBuffer('frame', this.frameUbo); return c;
        };
        this.classify = [mkClassify(this.nbA), mkClassify(this.nbB)];

        this.prep = this.cs('prep', compose(C, D, topoPrepWgsl), {
            classification: { group: 0, binding: 6 }, allocateBuf: { group: 0, binding: 8 },
            propagateBuf: { group: 0, binding: 9 }, simplifyBuf: { group: 0, binding: 7 },
            indirectArgs: { group: 0, binding: 11 }, prep: { group: 0, binding: 13 } });
        this.prep.setStorageBuffer('classification', this.classification);
        this.prep.setStorageBuffer('allocateBuf', this.allocateBuf);
        this.prep.setStorageBuffer('propagateBuf', this.propagateBuf);
        this.prep.setStorageBuffer('simplifyBuf', this.simplifyBuf);
        this.prep.setStorageBuffer('indirectArgs', this.indirectArgs);

        const mkSplit = (cur: StorageBuffer) => {
            const c = this.cs('split', compose(C, D, topoSplitWgsl), {
                heapID: { group: 0, binding: 2 }, nbCurrent: { group: 0, binding: 3 },
                bisData: { group: 0, binding: 5 }, classification: { group: 0, binding: 6 },
                memoryBuf: { group: 0, binding: 10 }, allocateBuf: { group: 0, binding: 8 } });
            c.setStorageBuffer('heapID', this.heapID); c.setStorageBuffer('nbCurrent', cur);
            c.setStorageBuffer('bisData', this.bisData); c.setStorageBuffer('classification', this.classification);
            c.setStorageBuffer('memoryBuf', this.memoryBuf); c.setStorageBuffer('allocateBuf', this.allocateBuf); return c;
        };
        this.split = [mkSplit(this.nbA), mkSplit(this.nbB)];

        this.alloc = this.cs('alloc', compose(C, D, topoAllocWgsl), {
            pool_bitfield: { group: 0, binding: 0 }, pool_tree: { group: 0, binding: 1 },
            bisData: { group: 0, binding: 5 }, allocateBuf: { group: 0, binding: 8 }, memoryBuf: { group: 0, binding: 10 } });
        this.alloc.setStorageBuffer('pool_bitfield', this.poolBitfield);
        this.alloc.setStorageBuffer('pool_tree', this.poolTree);
        this.alloc.setStorageBuffer('bisData', this.bisData);
        this.alloc.setStorageBuffer('allocateBuf', this.allocateBuf);
        this.alloc.setStorageBuffer('memoryBuf', this.memoryBuf);

        const mkCopy = (s: StorageBuffer, d: StorageBuffer) => {
            const c = this.cs('copy', compose(C, D, topoCopyWgsl), {
                nbCurrent: { group: 0, binding: 3 }, nbNext: { group: 0, binding: 4 } });
            c.setStorageBuffer('nbCurrent', s); c.setStorageBuffer('nbNext', d); return c;
        };
        this.copy = [mkCopy(this.nbA, this.nbB), mkCopy(this.nbB, this.nbA)];

        const mkBisect = (cur: StorageBuffer, nxt: StorageBuffer) => {
            const c = this.cs('bisect', compose(C, D, topoBisectWgsl), {
                pool_bitfield: { group: 0, binding: 0 }, heapID: { group: 0, binding: 2 },
                nbCurrent: { group: 0, binding: 3 }, nbNext: { group: 0, binding: 4 },
                bisData: { group: 0, binding: 5 }, allocateBuf: { group: 0, binding: 8 }, propagateBuf: { group: 0, binding: 9 } });
            c.setStorageBuffer('pool_bitfield', this.poolBitfield); c.setStorageBuffer('heapID', this.heapID);
            c.setStorageBuffer('nbCurrent', cur); c.setStorageBuffer('nbNext', nxt);
            c.setStorageBuffer('bisData', this.bisData); c.setStorageBuffer('allocateBuf', this.allocateBuf);
            c.setStorageBuffer('propagateBuf', this.propagateBuf); return c;
        };
        this.bisect = [mkBisect(this.nbA, this.nbB), mkBisect(this.nbB, this.nbA)];

        // PropagateBisect operates on the buffer Bisect WROTE (next). variant[0] (parity 0) -> next=B.
        const mkProp = (live: StorageBuffer) => {
            const c = this.cs('propBisect', compose(C, D, topoPropWgsl), {
                bisData: { group: 0, binding: 5 }, nbLive: { group: 0, binding: 3 }, propagateBuf: { group: 0, binding: 9 } });
            c.setStorageBuffer('bisData', this.bisData); c.setStorageBuffer('nbLive', live);
            c.setStorageBuffer('propagateBuf', this.propagateBuf); return c;
        };
        this.propBisect = [mkProp(this.nbB), mkProp(this.nbA)];

        const mkIndex = (live: StorageBuffer) => {
            const c = this.cs('index', compose(C, D, topoIndexWgsl), {
                heapID: { group: 0, binding: 2 }, nbLive: { group: 0, binding: 3 },
                bisData: { group: 0, binding: 5 }, indexation: { group: 0, binding: 12 } });
            c.setStorageBuffer('heapID', this.heapID); c.setStorageBuffer('nbLive', live);
            c.setStorageBuffer('bisData', this.bisData); c.setStorageBuffer('indexation', this.indexation); return c;
        };
        this.index = [mkIndex(this.nbA), mkIndex(this.nbB)]; // post-swap current

        this.reduce = this.cs('reduce', poolWgslPreamble(C) + ocbtPoolWgsl + '\n' + ocbtPoolReduceWgsl, {
            pool_bitfield: { group: 0, binding: 0 }, pool_tree: { group: 0, binding: 1 }, reduceParams: { group: 0, binding: 2 } });
        this.reduce.setStorageBuffer('pool_bitfield', this.poolBitfield); this.reduce.setStorageBuffer('pool_tree', this.poolTree);

        this.liveDisp = this.cs('liveDisp', poolWgslPreamble(C) + ocbtPoolWgsl + '\n' + topoDispWgsl, {
            pool_tree: { group: 0, binding: 1 }, liveDispatchArgs: { group: 0, binding: 11 } });
        this.liveDisp.setStorageBuffer('pool_tree', this.poolTree); this.liveDisp.setStorageBuffer('liveDispatchArgs', this.liveArgs);
    }

    async whenReady(timeoutMs = 8000): Promise<void> {
        const all = [this.reset, this.prep, this.alloc, this.reduce, this.liveDisp,
            ...this.classify, ...this.split, ...this.copy, ...this.bisect, ...this.propBisect, ...this.index];
        const end = performance.now() + timeoutMs;
        while (!all.every((c) => c.isReady())) {
            if (performance.now() > end) throw new Error('OcbtTopologyKernel not ready (timeout)');
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    uploadSeed(): void {
        const C = this.capacity;
        const bf = new Uint32Array(C >>> 5 || 1), heap = new Uint32Array(C * HEAP_STRIDE);
        const nb = new Uint32Array(C * NB_STRIDE).fill(INVALID), bis = new Uint32Array(C * BIS_STRIDE);
        for (let i = 0; i < 8; i++) {
            bf[i >>> 5] |= 1 << (i & 31);
            const id = mkU64(8 + i); heap[i * HEAP_STRIDE] = id[0]; heap[i * HEAP_STRIDE + 1] = id[1];
            const [base, left, right] = ROOT_NB[i];
            nb[i * NB_STRIDE + N_LEFT] = left; nb[i * NB_STRIDE + N_RIGHT] = right; nb[i * NB_STRIDE + N_BASE] = base;
            bis[i * BIS_STRIDE + 6] = 0x1; // flags lane = VISIBLE_BISECTOR
        }
        this.poolBitfield.update(bf); this.heapID.update(heap);
        this.nbA.update(nb); this.nbB.update(nb); this.bisData.update(bis);
        this.runReduce(); this.parity = 0; // pool_tree valid before frame 0
    }

    private cur(): StorageBuffer { return this.parity === 0 ? this.nbA : this.nbB; }
    private prepDispatch(mode: number): void { this.prep.setUniformBuffer('prep', this.prepUbo[mode]); this.prep.dispatch(1, 1, 1); }

    runFrame(p: OcbtTopoFrameParams): void {
        this.frameUbo.updateFloat4('camLocalRadius', p.camLocal[0], p.camLocal[1], p.camLocal[2], p.radius);
        this.frameUbo.updateFloat4('thresholds', p.focal, p.splitThreshold, p.mergeThreshold, p.cullMinDot ?? -0.05);
        this.frameUbo.updateInt4('ints', this.maxDepth, 3, p.cullBackface ? 1 : 0, p.enableSimplify ? 1 : 0);
        this.frameUbo.update();
        const k = this.parity; // 0 => current=A (variant ab), 1 => current=B (variant ba)
        this.liveDisp.dispatch(1, 1, 1);                               // 0
        this.reset.dispatch(1, 1, 1);                                  // 1
        this.classify[k].dispatchIndirect(this.liveArgs);             // 2
        this.prepDispatch(0);                                          // 3 split args
        this.split[k].dispatchIndirect(this.indirectArgs);           // 4
        this.prepDispatch(1);                                          // 5 alloc args
        this.alloc.dispatchIndirect(this.indirectArgs);              // 6
        const [gx, gy] = grid2D(Math.ceil((this.capacity * NB_STRIDE) / WG));
        this.copy[k].dispatch(gx, gy, 1);                            // 7 neighbor copy cur->next
        this.bisect[k].dispatchIndirect(this.indirectArgs);         // 8 read cur, write next
        this.prepDispatch(2);                                          // 9 propBisect args
        this.propBisect[k].dispatchIndirect(this.indirectArgs);     // 10 (k indexes next buffer)
        // 11. optional simplify block (PrepareSimplify/Simplify/PropagateSimplify) — see openQuestions
        this.runReduce();                                             // 12
        this.parity ^= 1;                                             // 13 swap (next is now current)
        this.index[this.parity].dispatchIndirect(this.liveArgs);    // 14 indexation on current
    }

    private runReduce(): void {
        this.reduce.setUniformBuffer('reduceParams', this.reduceUbo[this.depth]);
        let [gx, gy] = grid2D(Math.ceil(this.capacity / WG)); this.reduce.dispatch(gx, gy, 1);
        for (let lvl = this.depth - 1; lvl >= 0; lvl--) {
            [gx, gy] = grid2D(Math.ceil((1 << lvl) / WG));
            this.reduce.setUniformBuffer('reduceParams', this.reduceUbo[lvl]); this.reduce.dispatch(gx, gy, 1);
        }
    }

    async readLiveCount(): Promise<number> {
        const b = (await this.poolTree.read(4, 4)) as Uint8Array; // pool_tree[1]
        return new Uint32Array(b.buffer, b.byteOffset, 1)[0] >>> 0;
    }

    async readTopologySnapshot(): Promise<{ bitfield: Uint32Array; heapID: Uint32Array; neighbors: Uint32Array }> {
        const r = async (sb: StorageBuffer) => {
            const b = (await sb.read(0, undefined, undefined, true)) as Uint8Array;
            return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
        };
        return { bitfield: await r(this.poolBitfield), heapID: await r(this.heapID), neighbors: await r(this.cur()) };
    }

    dispose(): void {
        for (const u of this.reduceUbo) u.dispose(); for (const u of this.prepUbo) u.dispose(); this.frameUbo.dispose();
        [this.poolBitfield, this.poolTree, this.heapID, this.nbA, this.nbB, this.bisData, this.classification,
         this.allocateBuf, this.propagateBuf, this.simplifyBuf, this.memoryBuf, this.indirectArgs, this.liveArgs,
         this.indexation].forEach((b) => b.dispose());
    }
}
```

### pitfalls
- No Babylon buffer-copy API: the reference copy_graphics_buffer(current,next) MUST become a compute copy pass (ocbt_topo_copy_neighbors: one thread per u32, nbNext[i]=nbCurrent[i], ceil(4*capacity/256) groups with 2D spill). Single biggest deviation from the HLSL. Flagged per the prompt.
- Fixed bind groups: Babylon binds StorageBuffers at setStorageBuffer time; you cannot re-point a binding per frame. Hence AB/BA pre-built variants for every neighbor-touching pass + the copy pass, picked by parity (same 'pre-build per state' trick GpuCbtKernel uses for per-level UBOs).
- Reflection strips unused bindings: declaring but not referencing a buffer drops it from the layout; then setStorageBuffer on it (or any absent slot) invalidates the whole bind group (documented in ocbt_pool_gpu_harness decode). Each pass's bindingsMapping + setStorageBuffer must list ONLY buffers it actually uses.
- UBO write coalescing: writing one UniformBuffer between same-submit dispatches makes every dispatch see the LAST value. reduce levels and prepare-indirect modes each need their OWN pre-built UBO (reduceUbo[], prepUbo[]) — same lesson as GpuCbtKernel.levelParams.
- WGSL has no u64: heapID is vec2<u32> (ocbt_u64). Child heap-id math (2h, 4h+1, 4h+2, 4h+3) uses u64_shl/u64_or, NOT native multiply; HeapIDDepth = u64_depth (firstLeadingBit on hi lane).
- Atomic type segregation: a buffer declared array<atomic<u32>> in one pass and array<u32> in another is fine ONLY because each pass is a separate compose unit. subdivisionPattern (bisData lane 0) and the counters need atomicOr/atomicAdd in Split/Bisect/Classify; memoryBuf is array<atomic<i32>> (goes negative during Split's over-reservation rollback). Read-only passes declare them plain.
- array<vec3<u32>> stride trap: vec3 in a storage array pads to 16-byte stride and silently corrupts a packed neighbor array. Store neighbors FLAT (4 u32/slot, explicit pad) — also makes the copy pass and readback trivial.
- Pool decode needs a FRESH reduce: pool_decodeBitComplement walks pool_tree, so Allocate is only correct if pool_tree reflects the start-of-frame bitfield. uploadSeed() runs runReduce() before frame 0, and runFrame runs runReduce() AFTER bisect/simplify each frame. Reduce stays DIRECT (count=2^level data-independent) per GpuCbtKernel.runReduction.
- dispatchIndirect no-ops before isReady(): all 17 pipelines must pass whenReady() polling before runFrame, exactly like GpuCbtKernel.whenReady, or frame 0 silently does nothing.
- Readback submit: in the dev cross-check (no render loop) use StorageBuffer.read(0,undefined,undefined,true) (noDelay=true => flushFramebuffer) like ocbt_pool_gpu_harness. In the live engine use a non-forced read (readLiveCount) to avoid a pipeline stall.
- Indirect args 2D spill: ceil(liveCount/256) can exceed 65535; the dispatch-args builder spills X into Y (like cbt_dispatch_args) and every indirect pass reconstructs the linear handle as gid.x + gid.y*nwg.x*256u (matches ocbt_pool_reduce/decode).
- Cross-check compares INVARIANTS not slot indices: concurrent decode_bit_complement hands out free slots in a different order than the sequential mirror's freeStack, so only live heapID multiset / neighbor reciprocity / 0-T-junction (verts via lebDecode) are valid comparisons. Apply the ref->oracle lane remap (n0=LEFT,n1=RIGHT,n2=BASE) before comparing reciprocity against OcbtTopology.


## DRAFT: draft:crosscheck

### design
## Goal & equivalence model

Cross-check the CONCURRENT GPU OCBT bisector engine against the SEQUENTIAL CPU mirror `OcbtTopology` (`src/systems/lod/cbt/ocbt/ocbt_topology.ts`) by driving BOTH with the SAME deterministic classify metric for K frames and asserting INVARIANT equivalence (not pool indices — concurrent allocation order differs from the sequential free-stack).

The harness mirrors the PROVEN `ocbt_pool_gpu_harness.ts` + `ocbt_pool_gpu_test_main.ts` + `ocbt-test.html` pattern (own WebGPU engine via `EngineManager.CreateWebGPU`, compose compute, `StorageBuffer.read(0,undefined,undefined,true)` forced readback, DOM PASS/FAIL + `window.__OCBT_GPU_RESULT__`). It adds a SECOND dev entry `ocbtTopoTest` so the existing pool page is untouched.

## Why a fixpoint metric makes sequential==concurrent

The mirror splits one leaf at a time (sequential); the GPU splits a whole batch atomically per pass. These converge to the SAME leaf set ONLY if the target refinement is a deterministic, order-independent FIXPOINT — i.e. the metric is a pure function of a leaf's heapID/geometry, not of which leaves already split this frame, and the LEPP/forced-diamond conformity closure is confluent (it is: Rivara LEPP yields the unique minimal conforming refinement of a target set).

Metric: **split-to-fixed-target.** Pick a small set of fixed unit-sphere targets `T[]` (deterministic constants). A leaf is "wanted" iff `max_t(dot(centroid(leaf), t)) > cosCap` AND `leaf.depth-3 < targetDepth(leaf)`, where `targetDepth` is a pure step function of the angular distance to the nearest target (closer ⇒ deeper). Classify returns BISECT for every wanted leaf each pass. Run passes until no leaf is wanted (fixpoint). Because:
- wantedness depends only on the leaf's own geometry+depth (pure),
- conforming-split only ADDS triangles needed for conformity (monotone), and
- the cap/targetDepth are bounded ⇒ the iteration is monotone and bounded ⇒ unique fixpoint.

Drive the mirror with the IDENTICAL predicate: each mirror "frame", snapshot `topo.leaves()`, compute the wanted set with the same `wanted(centroid,depth)` function, call `topo.splitSlots(wantedSlots)`; repeat until a frame makes 0 splits. Both reach the same leaf multiset. (Merge symmetry is checked in a second scenario: refine to target A, then move target to B and let both split toward B AND merge leaves now below threshold; the merge guards in the mirror and `SimplifyElement`/`PrepareSimplifyElement` on GPU both produce the conservative diamond-collapse fixpoint.)

K frames: run `targetDepth` ramping from low to high over K frames so the harness exercises progressive refinement (frame f uses `targetDepth_f = baseDepth + f`), then optionally a few merge frames ramping back down. Assert invariants after EACH frame, not only at the end — catches transient T-junctions the GPU concurrent passes could introduce mid-refinement.

## Invariants compared (the 4 asserts)

Decode GPU buffers into the same `BisectorView[]`-shaped list as `topo.leaves()`, then:

1. **Live heapID multiset identical.** Sort both live heapID lists; assert element-wise equal. heapID is the order-INDEPENDENT identity of a leaf (LEB id), so equal multisets ⇒ same leaf set regardless of pool slot. This is the primary equivalence.
2. **Same live count.** `gpuLive.length === mirrorLeaves.length` (redundant with #1 but a cheap early-out + clearer failure message).
3. **GPU neighbor reciprocity/symmetry.** For every live GPU leaf, each non-INVALID neighbor must be live and must list this leaf back (port of `ValidateBisector`). Checked on GPU-decoded neighbors using the GPU's OWN slot indices (reciprocity is slot-local, so no mirror mapping needed). Also assert the mirror passes the same check (it does, by construction) so the two checkers are identical code.
4. **0 T-junction via decoded verts.** For each GPU live leaf, decode its 3 corners from heapID with `lebDecode(heapID, depth)` (NOT from any GPU vertex buffer — heapID is the source of truth). Build the undirected edge multiset; assert every edge count == 2 (watertight). Run the SAME `watertightViolations` on the mirror leaves. This is the strongest conformity check and is intrinsic to heapID, so it validates the GPU produced a crack-free LEB triangulation.

A 5th cross-invariant (strongest): build a Set of heapIDs from the mirror, and assert the GPU's edge-adjacency graph induced over heapIDs is isomorphic to the mirror's. In practice #1+#4 already pin this; keep it as an optional deep check behind a flag.

## Convention mapping (GPU reference ↔ World42 mirror)

CRITICAL reconciliation (confirmed by reading both sources):
- **Neighbor order.** Reference `uint3 = (n0,n1,n2)` with `n2 = twin = split-edge/hypotenuse`, `n0/n1 = leg neighbors`. World42 mirror stores `[BASE,LEFT,RIGHT]` with `BASE = hypotenuse twin`. Mapping: **World42.BASE ≡ ref.n2**, **World42.LEFT ≡ ref.n0**, **World42.RIGHT ≡ ref.n1**. The WGSL kernel (other agent's piece) should store neighbors in World42 `[BASE,LEFT,RIGHT]` order so the harness reads `[0]=BASE,[1]=LEFT,[2]=RIGHT` directly. The harness's reciprocity check is order-agnostic (it scans all 3), so it is robust even if the kernel keeps reference order — but document the chosen order in the buffer layout so #1's heapID labeling (2h/2h+1 child rule) stays consistent.
- **Depth convention.** World42 `lebDepth(heapID)` = floor(log2(heapID)); face ids 8..15 ⇒ depth 3; `BisectorView.depth = level+3`. Reference `HeapIDDepth = firstbithigh+1` = bit-length = World42 depth + 1. The harness ALWAYS uses World42 `lebDepth` on read-back heapIDs (the GPU stores the same numeric heapID; only the depth *function* differs). Pass `depth = lebDepth(heapID)` into `lebDecode`. Do NOT use the reference depth formula anywhere in TS.
- **INVALID neighbor.** Reference `INVALID_POINTER = 0xFFFFFFFF`; mirror uses `-1`. The harness treats GPU neighbor `== 0xFFFFFFFF` as "none" (skip in reciprocity, no T-junction contribution — boundary edges don't exist on a closed octahedron so a live leaf should have 0 INVALID neighbors; assert that too as a sanity invariant).
- **Live test.** A GPU slot is live iff its heapID != 0 (reference uses heapID==0 as the dead/deallocated marker — see `BisectorElementIndexation`/`SimplifyElement` clearing heapID to 0). The harness scans `[0, capacity)` and keeps slots with `heapID(lo,hi) != (0,0)`.

## GPU readback contract (what the kernel must expose)

The harness reads three StorageBuffers the kernel owns (names are the binding hints):
- `heapId`  : `array<vec2<u32>>` length `capacity` (u64 lo/hi per slot; 0 ⇒ dead). READ flag set.
- `neighbors` : `array<vec3<u32>>` length `capacity` (World42 [BASE,LEFT,RIGHT]; 0xFFFFFFFF = none). READ flag set. (vec3 in a storage array is 16-byte stride per element in std430 → the harness strides by 4 u32 and reads lanes 0..2.)
- `liveIndices` + `liveCount` : optional fast path. The kernel's `BisectorElementIndexation` already compacts live slots into `_BisectorIndicesBuffer` with count in an indirect-draw word. If exposed, the harness iterates only live slots (cheap at depth). If NOT exposed, the harness falls back to the full `[0,capacity)` scan filtering heapID!=0 (always correct, just O(capacity) readback). Draft supports BOTH (uses liveIndices if `liveCountBuf` provided).

The harness does NOT read the pool bitfield/sum-tree for equivalence (those are allocation-order artifacts); it reads only heapID+neighbors, the order-independent topology.

## Pass order per frame (mirror of mesh_updater.cpp)

The harness calls the kernel's frame method; the kernel internally runs: ResetBuffers → Classify (with the deterministic metric uniforms) → (split path) SplitElement → AllocateElement → BisectElement → PropagateBisectElement; OR (merge path) PrepareSimplify → Simplify → PropagateSimplify; then BisectorElementIndexation + sum-reduction. The harness only needs `kernel.runFrame(metricParams)` + `kernel.whenReady()` + readback. It alternates/loops passes until the GPU `liveCount` is stable across two consecutive reads (GPU fixpoint reached) — mirroring the mirror's "until 0 splits" loop — so both compare at their respective fixpoints for that frame's target.

## Metric uniform plumbing

The deterministic metric is encoded as uniforms the kernel's ClassifyBisector reads: target count, up to N target dirs (vec4 each: xyz=dir, w=cosCap_for_that_target), and a `targetDepth` LUT or a single `(baseDepth, depthPerCapStep)` pair. The harness computes the IDENTICAL predicate on CPU for the mirror. To guarantee bit-identical thresholds, both use `f32`-rounded constants (the harness rounds its CPU dot/cap to f32 via `Math.fround` before comparing to the cap) so a leaf near the boundary classifies the same on both — this is the subtle correctness point: a metric that is order-independent but uses f64 on CPU vs f32 on GPU can flip a borderline leaf and break #1. Use caps chosen so NO centroid lands within 1e-4 of a cap boundary (the fixed targets are placed at face/vertex interiors; document the safety margin), making the f32/f64 difference irrelevant.

### bindings
The harness OWNS no GPU buffers itself — it reads buffers the kernel (`GpuOcbtTopoKernel`, the sibling piece) creates. The contract it depends on:

Kernel-owned StorageBuffers (all created with Constants.BUFFER_CREATIONFLAG_STORAGE | _READ | _WRITE; the harness only needs READ/CopySrc on these three):
- heapId       group 0, binding (kernel-internal) : array<vec2<u32>>, length = capacity, bytes = capacity*8. Element = [lo, hi] u64 heapID; (0,0) => dead slot. Readback length (u32) = capacity*2.
- neighbors    : array<vec3<u32>>, length = capacity. std430 storage stride for vec3 = 16 bytes (padded), bytes = capacity*16, readback length (u32) = capacity*4 (lane 3 is padding). Order per element = [BASE, LEFT, RIGHT] (World42 convention = ref [n2, n0, n1]); 0xFFFFFFFF = no neighbor.
- liveIndices (optional) : array<u32>, compacted live slot ids from BisectorElementIndexation; paired with a liveCount u32 (e.g. _IndirectDrawBuffer[0]/3). If absent, harness does a full [0,capacity) scan filtering heapID!=0.

Metric uniforms the kernel's Classify reads (harness must set the SAME values it uses on CPU). Suggested UniformBuffer 'topoMetric':
- targets : array<vec4<f32>, N> — xyz = unit target dir, w = per-target cosCap (or one global cap in a scalar).
- ints    : vec4<u32> = (targetCount, targetDepth, mode/*0 split 1 merge*/, maxDepth).
- caps    : vec4<f32> = (cosCap, 0,0,0)  // global cap if not per-target.

Readback method on each buffer (mirror of ocbt_pool_gpu_harness): `(await buf.read(0, undefined, undefined, true)) as Uint8Array` then wrap as Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength>>2). The `true` (noDelay) forces flushFramebuffer to submit the recorded compute passes — required, there is no render loop.

No new bindings are introduced by the harness; it is a pure consumer + the OcbtTopology mirror (plain typed arrays, no GPU).

### codeDraft
```
/* =====================================================================
 * src/systems/lod/cbt/ocbt/ocbt_topo_gpu_harness.ts
 * Drives the GPU OCBT topology kernel and reads back the order-independent
 * topology (heapID + neighbors) for invariant cross-check vs OcbtTopology.
 * Mirrors ocbt_pool_gpu_harness.ts (own buffers, forced readback). The kernel
 * itself (GpuOcbtTopoKernel) is the OTHER agent's piece; this harness only
 * needs its frame() + whenReady() + the three readable StorageBuffers.
 * ===================================================================== */
import { type WebGPUEngine } from '@babylonjs/core';

/** Deterministic split metric shared by GPU uniforms and the CPU mirror. */
export interface TopoMetric {
    /** Fixed unit-sphere targets; refinement concentrates around these. */
    targets: ReadonlyArray<readonly [number, number, number]>;
    /** Per-target cosine cap: leaf wanted if dot(centroid,target) > cap. */
    cosCap: number;
    /** Leaf wanted only while (depth-3) < targetDepth for this frame. */
    targetDepth: number;
    /** 0 = refine (split toward targets), 1 = coarsen (merge away). */
    mode: 0 | 1;
}

/** A decoded GPU leaf, shaped like OcbtTopology.BisectorView for shared checks. */
export interface GpuLeaf {
    slot: number;
    heapID: number;            // exact int (depth < 53 in tests)
    depth: number;             // lebDepth(heapID)
    neighbors: [number, number, number]; // GPU slots, [BASE,LEFT,RIGHT], -1=none
}

const INVALID = 0xffffffff;

/**
 * The kernel contract this harness depends on. Implemented by the GPU piece.
 * frame() runs one full update pass-chain for the given metric; readback
 * buffers are exposed as Babylon StorageBuffers with the READ flag.
 */
export interface GpuOcbtTopoKernel {
    readonly capacity: number;
    whenReady(timeoutMs?: number): Promise<void>;
    /** Run reset->classify->split/merge->bisect/simplify->propagate->index. */
    frame(m: TopoMetric): void;
    /** vec2<u32> per slot (u64 heapID; 0 => dead). */
    readHeapId(): Promise<Uint32Array>;       // length capacity*2
    /** vec3<u32> per slot, std430 16B stride => length capacity*4 (lane3 pad). */
    readNeighbors(): Promise<Uint32Array>;    // length capacity*4
    /** Optional compacted live-slot list + count; null => full scan fallback. */
    readLiveIndices?(): Promise<{ indices: Uint32Array; count: number }>;
    dispose(): void;
}

/** lebDepth duplicated locally to avoid import churn; matches ocbt_leb.ts. */
function lebDepth(heapID: number): number {
    if (heapID < 1) return 0;
    if (heapID < 0x1_0000_0000) return 31 - Math.clz32(heapID >>> 0);
    const hi = Math.floor(heapID / 0x1_0000_0000);
    return 32 + (31 - Math.clz32(hi >>> 0));
}

/** Read back the GPU and decode the live leaf set (order-independent topology). */
export async function readGpuLeaves(k: GpuOcbtTopoKernel): Promise<GpuLeaf[]> {
    const heap = await k.readHeapId();      // capacity*2
    const nb = await k.readNeighbors();     // capacity*4 (16B stride)
    const out: GpuLeaf[] = [];

    const decodeSlot = (slot: number): GpuLeaf | null => {
        const lo = heap[slot * 2] >>> 0;
        const hi = heap[slot * 2 + 1] >>> 0;
        if (lo === 0 && hi === 0) return null; // dead
        // heapID exact as JS number (tests stay < 2^53).
        const heapID = hi * 0x1_0000_0000 + lo;
        const b = nb[slot * 4 + 0] >>> 0;
        const l = nb[slot * 4 + 1] >>> 0;
        const r = nb[slot * 4 + 2] >>> 0;
        const conv = (x: number) => (x === INVALID ? -1 : x);
        return {
            slot,
            heapID,
            depth: lebDepth(heapID),
            neighbors: [conv(b), conv(l), conv(r)]
        };
    };

    if (k.readLiveIndices) {
        const { indices, count } = await k.readLiveIndices();
        for (let i = 0; i < count; i++) {
            const g = decodeSlot(indices[i] >>> 0);
            if (g) out.push(g);
        }
        return out;
    }
    for (let slot = 0; slot < k.capacity; slot++) {
        const g = decodeSlot(slot);
        if (g) out.push(g);
    }
    return out;
}

/* =====================================================================
 * Invariant comparison — pure, no Babylon. Reused for both GPU and mirror
 * leaf lists so the two are checked by IDENTICAL code.
 * ===================================================================== */
import { lebDecode } from './ocbt_leb';

export interface LeafLike {
    slot: number;
    heapID: number;
    depth: number;
    neighbors: [number, number, number];
}

const keyOf = (v: readonly number[]) =>
    `${v[0].toFixed(9)},${v[1].toFixed(9)},${v[2].toFixed(9)}`;
const edgeKey = (p: readonly number[], q: readonly number[]) => {
    const a = keyOf(p), b = keyOf(q);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
};

/** #4: 0 T-junction via heapID-decoded verts (every undirected edge shared==2). */
export function tjunctionViolations(leaves: LeafLike[]): number {
    const counts = new Map<string, number>();
    for (const t of leaves) {
        const { a, l, r } = lebDecode(t.heapID, t.depth);
        for (const [p, q] of [[a, l], [l, r], [r, a]] as const) {
            const k = edgeKey(p, q);
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
    }
    let bad = 0;
    for (const c of counts.values()) if (c !== 2) bad++;
    return bad;
}

/** #3: neighbor reciprocity/symmetry over slot-local indices. */
export function reciprocityViolations(leaves: LeafLike[]): number {
    const bySlot = new Map<number, LeafLike>();
    for (const t of leaves) bySlot.set(t.slot, t);
    let bad = 0;
    for (const t of leaves) {
        for (const n of t.neighbors) {
            if (n < 0) continue;
            const nb = bySlot.get(n);
            if (!nb || !nb.neighbors.includes(t.slot)) bad++;
        }
    }
    return bad;
}

/** #1: live heapID multiset equality. Returns first mismatch or null. */
export function heapIdMultisetDiff(
    gpu: LeafLike[],
    mirror: LeafLike[]
): { gpuLen: number; cpuLen: number; firstMismatch?: { i: number; g: number; c: number } } | null {
    const g = gpu.map((t) => t.heapID).sort((a, b) => a - b);
    const c = mirror.map((t) => t.heapID).sort((a, b) => a - b);
    if (g.length !== c.length)
        return { gpuLen: g.length, cpuLen: c.length };
    for (let i = 0; i < g.length; i++) {
        if (g[i] !== c[i])
            return { gpuLen: g.length, cpuLen: c.length, firstMismatch: { i, g: g[i], c: c[i] } };
    }
    return null;
}

/* =====================================================================
 * src/systems/lod/cbt/ocbt/ocbt_topo_gpu_test_main.ts  (dev entry)
 * ===================================================================== */
import { EngineManager } from '../../../../core/render/engine_manager';
import { OcbtTopology } from './ocbt_topology';
// import { GpuOcbtTopoKernel impl } from './gpu/gpu_ocbt_topo_kernel'; // other agent
import {
    readGpuLeaves,
    tjunctionViolations,
    reciprocityViolations,
    heapIdMultisetDiff,
    type TopoMetric,
    type GpuOcbtTopoKernel,
    type LeafLike
} from './ocbt_topo_gpu_harness';
import type { WebGPUEngine, BisectorView } from '@babylonjs/core';

interface CaseResult { name: string; pass: boolean; detail: string; }
declare global {
    interface Window {
        __OCBT_TOPO_GPU_RESULT__?: { pass: boolean; cases: CaseResult[]; error?: string };
    }
}

/** Centroid on the unit sphere from heapID-decoded corners (matches GPU classify). */
function centroidOf(t: LeafLike): [number, number, number] {
    const { a, l, r } = lebDecodeLocal(t.heapID, t.depth);
    const x = a[0] + l[0] + r[0], y = a[1] + l[1] + r[1], z = a[2] + l[2] + r[2];
    const inv = 1 / Math.hypot(x, y, z);
    return [x * inv, y * inv, z * inv];
}
import { lebDecode as lebDecodeLocal } from './ocbt_leb';

/**
 * Pure, order-independent "wanted" predicate — IDENTICAL math the GPU runs.
 * f32-round dot+cap so a borderline leaf classifies the same on both sides.
 * Targets are placed in face interiors (safe margin) so no leaf is on a cap edge.
 */
function wanted(t: LeafLike, m: TopoMetric): boolean {
    if (t.depth - 3 >= m.targetDepth) return false;
    const c = centroidOf(t);
    let best = -2;
    for (const tg of m.targets) {
        const d = Math.fround(c[0] * tg[0] + c[1] * tg[1] + c[2] * tg[2]);
        if (d > best) best = d;
    }
    return best > Math.fround(m.cosCap);
}

/** Drive the mirror to the fixpoint for metric m (split-only here). */
function refineMirror(topo: OcbtTopology, m: TopoMetric): void {
    // Iterate to fixpoint: each pass split every currently-wanted leaf.
    for (let guard = 0; guard < 64; guard++) {
        const leaves = topo.leaves() as unknown as LeafLike[];
        const slots = leaves.filter((t) => wanted(t, m)).map((t) => t.slot);
        if (slots.length === 0) break;
        const n = topo.splitSlots(slots);
        if (n === 0) break; // depth-capped fixpoint
    }
}

/** One frame: drive GPU to its fixpoint, drive mirror to its fixpoint, compare. */
async function runFrame(
    name: string,
    kernel: GpuOcbtTopoKernel,
    topo: OcbtTopology,
    m: TopoMetric
): Promise<CaseResult> {
    // GPU: loop frames until live count stable (concurrent fixpoint).
    let prev = -1, stable = 0;
    for (let i = 0; i < 64 && stable < 2; i++) {
        kernel.frame(m);
        const live = (await readGpuLeaves(kernel)).length;
        stable = live === prev ? stable + 1 : 0;
        prev = live;
    }
    refineMirror(topo, m);

    const gpu = await readGpuLeaves(kernel);
    const mir = topo.leaves() as unknown as LeafLike[];

    const diff = heapIdMultisetDiff(gpu, mir);
    if (diff) {
        const fm = diff.firstMismatch;
        return {
            name, pass: false,
            detail: fm
                ? `heapID[${fm.i}] GPU=${fm.g} CPU=${fm.c} (gpuLive=${diff.gpuLen} cpuLive=${diff.cpuLen})`
                : `live count GPU=${diff.gpuLen} CPU=${diff.cpuLen}`
        };
    }
    const recip = reciprocityViolations(gpu);
    if (recip !== 0)
        return { name, pass: false, detail: `GPU neighbor reciprocity violations=${recip}` };
    const tj = tjunctionViolations(gpu);
    if (tj !== 0)
        return { name, pass: false, detail: `GPU T-junctions=${tj}` };
    // Sanity: mirror passes the same checks (must, by construction).
    if (reciprocityViolations(mir) !== 0 || tjunctionViolations(mir) !== 0)
        return { name, pass: false, detail: `mirror self-check failed (test bug)` };

    return { name, pass: true, detail: `live=${gpu.length} recip=0 tjunc=0 heapID-multiset OK` };
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
        window.__OCBT_TOPO_GPU_RESULT__ = { pass: false, cases, error };
        render(out, cases, false, error);
        return;
    }

    try {
        const MAXD = 18; // World42 level cap (depth = level+3); keep < 2^53 heapID.
        // Face-interior targets (safe cap margin so f32/f64 never flips a leaf).
        const TARGETS: [number, number, number][] = [
            normalize(0.6, 0.7, 0.39),    // near +y/+x/+z face interior
            normalize(-0.55, -0.62, 0.56) // a -y face interior
        ];
        const COS_CAP = 0.92; // small angular caps -> deep local refinement

        // Construct the kernel (other agent's impl). Capacity comfortably above
        // the fixpoint leaf count for these caps/depths.
        const kernel: GpuOcbtTopoKernel =
            new (await import('./gpu/gpu_ocbt_topo_kernel')).GpuOcbtTopoKernel(
                engine, 'xcheck', MAXD, 1 << 16
            );
        await kernel.whenReady();
        const topo = new OcbtTopology(MAXD);

        // K progressive-refine frames: ramp targetDepth up.
        const K = MAXD - 3;
        for (let f = 0; f < K; f++) {
            const m: TopoMetric = {
                targets: TARGETS, cosCap: COS_CAP, targetDepth: 1 + f, mode: 0
            };
            cases.push(await runFrame(`refine f=${f} td=${1 + f}`, kernel, topo, m));
            if (!cases[cases.length - 1].pass) break; // stop on first divergence
        }

        const pass = cases.every((c) => c.pass);
        window.__OCBT_TOPO_GPU_RESULT__ = { pass, cases };
        render(out, cases, pass);
    } catch (e) {
        const error = String((e as Error)?.stack ?? e);
        window.__OCBT_TOPO_GPU_RESULT__ = { pass: false, cases, error };
        render(out, cases, false, error);
    } finally {
        engine.dispose();
    }
}

function normalize(x: number, y: number, z: number): [number, number, number] {
    const i = 1 / Math.hypot(x, y, z);
    return [x * i, y * i, z * i];
}

void main();

/* =====================================================================
 * ocbt-topo-test.html  (copy of ocbt-test.html, different title/result var)
 * ===================================================================== */
/*
<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OCBT topology GPU cross-check</title>
<style>
 body{margin:0;background:#0b0b0f;color:#d8d8e0;font:13px/1.5 ui-monospace,Consolas,monospace}
 #out{white-space:pre;padding:16px}
 #c{position:fixed;width:8px;height:8px;left:-100px;top:-100px}
</style></head><body>
 <pre id="out">running OCBT topology GPU cross-check…</pre>
 <canvas id="c"></canvas>
</body></html>
*/

/* =====================================================================
 * rspack.config.js — add the second dev-only entry + HTML page.
 * (diff against the existing config)
 * ===================================================================== */
/*
 entry: {
     index: './src/index.ts',
     ...(isProd(argv) ? {} : {
         ocbtTest: './src/systems/lod/cbt/ocbt/ocbt_pool_gpu_test_main.ts',
         ocbtTopoTest: './src/systems/lod/cbt/ocbt/ocbt_topo_gpu_test_main.ts'  // NEW
     })
 },
 ...
 plugins: [
     new HtmlWebpackPlugin({ template: './index.html', chunks: ['index'] }),
     ...(isProd(argv) ? [] : [
         new HtmlWebpackPlugin({
             template: './ocbt-test.html', filename: 'ocbt-test.html', chunks: ['ocbtTest']
         }),
         new HtmlWebpackPlugin({                                              // NEW
             template: './ocbt-topo-test.html', filename: 'ocbt-topo-test.html',
             chunks: ['ocbtTopoTest']
         })
     ]),
     ...
 ]
*/
```

### pitfalls
- heapID multiset, NOT pool indices: concurrent atomic allocation (decode_bit_complement on InterlockedAdd order) yields different slot numbers than the mirror's sequential free-stack. Comparing slots WILL fail. Only sort+compare heapIDs (order-independent leaf identity). This is the single most important rule.
- Depth convention mismatch: World42 lebDepth = floor(log2(heapID)) (faces 8..15 => depth 3); the HLSL reference HeapIDDepth = firstbithigh+1 = bit-length = World42 depth + 1. In TS always use lebDepth on read-back heapIDs and pass that into lebDecode. Never port the reference +1 formula into TS — it will mis-decode every triangle.
- Neighbor order: reference uint3 = (n0=LEFT, n1=RIGHT, n2=twin/BASE); World42 = [BASE,LEFT,RIGHT]. The reciprocity check scans all 3 so it is order-robust, but the heapID child-labeling (2h/2h+1) and any T-junction debugging depends on getting BASE=hypotenuse right — assert the kernel writes World42 order, or remap on read.
- INVALID_POINTER is 0xFFFFFFFF on GPU, -1 in the mirror. Convert 0xFFFFFFFF -> -1 on readback or reciprocity/T-junction checks treat a 4-billion slot index as real and crash/false-fail. On a closed octahedron a live leaf should have ZERO invalid neighbors — assert that as an extra sanity invariant; any INVALID means a torn topology.
- vec3<u32> in a storage array has 16-byte std430 stride (padded to vec4), so the neighbors buffer is capacity*16 bytes and the harness must stride by 4 u32 per element and read lanes 0..2 (lane 3 is padding garbage). Reading 3-u32 stride silently misaligns every element after slot 0.
- Forced readback required: StorageBuffer.read(0,undefined,undefined,true) — the noDelay=true triggers flushFramebuffer to actually submit the recorded compute passes. Without a render loop, a non-forced read returns stale/zero buffers (the pool harness already relies on this).
- dispatch no-ops until isReady: await kernel.whenReady() before the first frame() or the first K passes silently do nothing and the GPU stays at the 8-leaf seed while the mirror refines -> spurious multiset mismatch that looks like a logic bug.
- f32 (GPU classify) vs f64 (CPU mirror predicate) can flip a borderline leaf's wantedness, breaking the multiset even though both engines are correct. Round the CPU dot+cap via Math.fround AND place targets in face interiors with a comfortable cap margin so no centroid sits within ~1e-4 of a cap boundary. A metric that is order-independent is necessary but NOT sufficient — it must also be FP-stable across precisions.
- Fixpoint convergence: the GPU splits in batches and may need several frame() calls to reach the same closure the mirror reaches via its until-0-splits loop (LEPP conformity can cascade). Loop GPU frame() until live count is stable across 2 reads before comparing; comparing after a single frame() will mismatch mid-refinement.
- heapID exactness: u64 carried as vec2<u32>; reconstruct as hi*2^32+lo. Exact only below 2^53 — keep MAXD low enough (depth = level+3; level<=18 => heapID well under 2^53). Above that, compare as BigInt or as (lo,hi) pairs, not as JS numbers.
- Mid-refinement assertion: assert invariants after EACH frame, not only at the final fixpoint — a concurrent BisectElement bug can create a transient T-junction that a later pass heals, which an end-only check would miss. The per-frame runFrame already does this.
- WGSL has no native firstbithigh on u64 — depth comes from ocbt_u64.u64FindMSB (vec2 lanes). Ensure the kernel and the harness's lebDepth agree on the SAME face-base (8..15 => depth 3); a 1-off here desyncs every decoded vertex and fails the T-junction check globally.
