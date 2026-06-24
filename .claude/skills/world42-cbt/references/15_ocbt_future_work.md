# OCBT — future work & improvement roadmap

Forward-looking plan for the **pool-CBT (OCBT) GPU terrain engine** once Phases 0–3 are
complete and validated (see `14_ocbt_gpu_topology_design.md` for the as-built design, and
`src/systems/lod/cbt/ocbt/readme.md` for the in-repo status).

**Where we are.** The paper's core goal — cost/memory decoupled from depth (pool allocator +
explicit bisectors) — is achieved and proven watertight (refine + coarsen) against the CPU
oracle (20/20 GPU-vs-oracle cross-check). Render path is live behind `?cbt=ocbt` with df64
camera-relative decode, frustum culling, draw compaction, and indirect dispatch of the 7
work-list passes. Crack-free to ~level 27 at the surface; usable-depth ceiling ~45.

**What "improvement" means now.** Three independent axes, in priority order:
1. **Performance** — kill the remaining `O(capacity)` per-frame floor.
2. **Precision** — push usable depth past ~45 toward the structural cap (60).
3. **Productionization** — promote from dev-only prototype to a selectable, stress-tested,
   measured engine.

This file is the standing backlog. Each item: *problem → approach → files → validation →
risk → payoff*. Do the cheap-and-safe ones first; the precision axis is open-ended and
gated by platform limits.

---

## 0. Triage of known critiques (what's real vs done)

A prototype audit (and our own bilan) surfaced these. Status as of Phase 3 complete:

| Critique | Verdict |
|---|---|
| "Most passes scan the whole capacity (`1<<20` threads/pass)" | **Half-addressed.** The 7 work-list passes now dispatch indirect over candidate counts. Classify, Compact, CopyNeighbors, EvalLeb and (dominant) **Reduce** genuinely still scan the full pool — that is the remaining floor (§1). |
| Sum-tree not packed (`2·capacity` u32) | **Real & open.** Now the dominant `O(capacity)` cost (§1.1). |
| Render compaction draws `live·2+8192` and the VS reads `ocbtIndices[instanceIndex]` without comparing to the GPU compaction count → stale-tail **duplicate** live triangles | **Real.** Duplicates are *visually harmless* (idempotent overdraw, no holes/cracks) but waste work and aren't robust (§2.1). |
| Camera-metric path only validated visually, not in the cross-check | **Real gap** (§3.2). |
| Split/merge artificially alternated by frame parity | **Real, by design.** Removable (§3.4). |
| Dev-only `?cbt=ocbt`, no GPU frame-time numbers | **By design / pending** (§3.1, §3.3). |
| Doc said neighbors are 4-u32 padded; code is 3-u32 flat | **Stale doc** — code is correct (§3.5). |
| Comments still mention "f32 caps depth ~16" | **Stale comments** — path is df64 now (§3.5). |

Nothing in the audit is *wrong*; the only inaccuracy is staleness — it predated the
indirect-dispatch work. Everything else matches our own honest assessment.

---

## 1. Performance — remove the `O(capacity)` floor (highest leverage)

Indirect dispatch already removed ~7 full-capacity work-list dispatches that did <5% useful
work. It is **not** asymptotic: the floor stays `O(capacity)` because a few passes must touch
every slot. Attack them in this order.

### 1.1 Pool Reduce → packed variable-bit-width tree  *(dominant cost — do first)*

- **Problem.** `pool_tree` is a simple `2·capacity`-u32 sum-tree; the per-frame reduce
  rebuilds it over the whole pool every frame regardless of live count.
- **Approach.** Port the reference's **packed variable-bit-width** tree
  (`ocbt_generic.hlsl` / `ocbt_256k.hlsl` / `ocbt_1m.h`): the upper levels need only a few
  bits per node, so the tree is far smaller and the reduce far cheaper. Keep the leaf
  bitfield as-is.
- **Files.** `src/assets/shaders/cbt/ocbt/ocbt_pool*.wgsl`,
  `src/systems/lod/cbt/ocbt/ocbt_pool.ts` (+ its `.test.ts` golden oracle),
  `ocbt_engine_buffers.ts` (tree sizing).
- **Validation.** The existing `ocbt_pool` Vitest golden suite (`decode_bit` /
  `decode_bit_complement` / reduce) must stay green against the CPU mirror; then the GPU
  cross-check 20/20 must still pass (reduce feeds Allocate).
- **Risk.** Medium-high — bit-packing off-by-one in descent. Golden tests gate it before any
  GPU dependency (same discipline as Phase 0).
- **Payoff.** Largest single win; this is *the* remaining dominant per-frame cost.

### 1.2 CopyNeighbors → `O(live)`

- **Problem.** The ping-pong neighbor copy (`nbNext[i]=nbCurrent[i]`) runs over the full
  `4·capacity` words each split frame (a Babylon limitation — no buffer-copy API).
- **Approach.** Iterate the compacted live index list instead of the whole pool.
- **Risk.** **Flagged risky** for the ping-pong invariant — a slot allocated *this* frame
  isn't in *last* frame's index list, so a naive live-only copy can leave its pong row stale.
  Validate the reciprocity invariant carefully (the cross-check's neighbor-reciprocity check
  is the gate) before shipping. Consider copying `live ∪ newly-allocated`.
- **Payoff.** Removes one of the four floor passes.

### 1.3 EvalLeb → indirect (after reordering Compact before EvalLeb)

- **Problem.** EvalLeb decodes every slot; only live slots matter.
- **Approach.** Run **Compact before EvalLeb** so EvalLeb can dispatch indirect over the
  compacted list and write only live slots. (Today the order is EvalLeb → Compact.)
- **Caveat.** The metric classify reads the positions buffer next frame; confirm every slot
  the classify touches has been decoded (decode the live set + any slot the classify reads).
- **Payoff.** Removes another floor pass; compounds with §2.1 (Compact already feeds the draw).

### 1.4 Classify → active-list

- **Problem.** Classify scans the full pool to find candidates.
- **Approach.** Drive it from the compacted live list (it only ever acts on live leaves).
- **Payoff.** The last easy floor pass; smaller than Reduce but cheap to do once §1.3 lands
  the Compact-first ordering.

> **Honest ceiling.** Even with all four, *discovery* passes that must observe newly-dead
> slots (or rebuild the allocator tree) keep some `O(capacity)` residue. The goal is to make
> per-frame cost track **live triangle count**, not pool capacity — §1.1 is 80% of that.

---

## 2. Render robustness

### 2.1 Eliminate compacted-draw stale-tail duplicates

- **Problem.** `OcbtSource` sets `forcedInstanceCount = min(cap, ceil(live·2)+8192)` (an
  over-estimate to absorb readback lag) and the VS reads `ocbtIndices[instanceIndex]` gated
  only on `heapID==0`. The tail `[liveCount, forcedInstanceCount)` holds **stale-but-valid**
  indices from prior frames → it redraws live triangles as harmless duplicates. The
  `heapID==0` gate catches *dead* slots, not *stale-live* ones.
- **Why it's only "robustness," not a bug.** Duplicates are idempotent overdraw (same
  geometry, same depth, same shading) — no holes, no cracks, no z-fighting artifact. The
  cost is wasted vertex work in the safety margin.
- **Fix (cheap & clean).** Bind the GPU compaction count (`drawCount[0]`, == `pool_tree[1]`)
  to the render material and gate in the VS: `if (instanceIndex >= drawCount[0]) { degenerate }`.
  Exact, no `O(capacity)` clear, removes all duplicates. This is the "GPU count in VS" option.
- **Alternative.** A true GPU-driven indirect *draw* (instance count from the buffer) — but
  Babylon doesn't expose instance count from a GPU buffer for `ShaderMaterial`, so the VS-gate
  is the pragmatic path. The same pattern would also tighten the legacy `gpu-implicit` path.
- **Files.** `ocbt_render_material.ts` (add binding + VS gate), `ocbt_source.ts` (can then
  drop the `·2+8192` over-estimate down to a small safety floor), `ocbt_topology_kernel.ts`
  (expose `drawCount` buffer to the material).
- **Validation.** Visual (no holes at 3 altitudes, wireframe overlay shows no double edges)
  + a WebGPU-inspector draw-count check.

---

## 3. Productionization

### 3.1 Promote `?cbt=ocbt` to a real per-planet selection

- Move the backend choice from the URL override into the planet config / scheduler default
  (`cbtType: 'cpu' | 'gpu-implicit' | 'gpu-ocbt'` already exists in `cbt_scheduler.ts`).
  Keep the URL param as a dev override. Gate the default switch on §3.3 numbers.
- **Files.** `cbt_scheduler.ts`, `stellar_catalog_loader.ts`,
  `app/setup_lod_and_shadows.ts`, `data.json` (per-planet field).

### 3.2 Camera-metric stress-test harness  *(close the validation gap)*

- **Problem.** The 20/20 cross-check uses the **deterministic predicate** classify; the real
  screen-space-area + frustum + horizon metric is only validated visually.
- **Approach.** Extend the dev cross-check (`ocbt_topology_gpu_test_main.ts`) with
  camera-driven scenarios run on **both** GPU and CPU oracle with the *same* metric:
  fast descent to ground, rotation across an octahedron seam, split/merge oscillation at a
  hysteresis boundary, pool saturation, teleport, sustained ground-level deep refinement.
  Assert watertightness + neighbor reciprocity **after each frame** (transient T-junctions a
  later pass heals are otherwise missed).
- **Caveat.** f32 (GPU) vs f64 (CPU) can flip a borderline leaf; round the CPU metric via
  `Math.fround` and keep a cap margin >1e-4 before comparing multisets (same mitigation as
  the predicate cross-check).

### 3.3 GPU frame-time instrumentation

- Measure actual GPU frame time at capacity 262k / 512k / 1M and live-count tiers, on real
  hardware (current dev was RDP-capped at ~32 FPS — wall-clock numbers are unreliable there).
  Use WebGPU timestamp queries / the inspector. These numbers gate §1 priorities and §3.1.

### 3.4 Split + merge in one frame (remove parity alternation)

- **Problem.** `OcbtSource` alternates `runFrame` (split) / `runMergeFrame` (merge) by frame
  parity to avoid racing the shared neighbor buffer → 2-frame latency, slower convergence,
  possible oscillation. The reference does both in one update.
- **Approach.** Run the merge half as the symmetric follow-on within one update (the design
  doc's STEP 10 dual), sharing the classify candidate lists, with a barrier between the split
  and merge neighbor writes.
- **Risk.** Concurrency on the neighbor ping-pong — gate on the per-frame reciprocity assert
  from §3.2 before enabling in the live path.

### 3.5 Doc & comment cleanup

- Remove stale comments referencing the old "f32 caps usable depth ~16" (the metric path is
  df64 now) in `ocbt_source.ts` and elsewhere.
- The neighbor stride is **3 u32 flat** in code (correct — avoids the `vec3` 16-byte trap);
  fix any doc/draft text in `14_ocbt_gpu_topology_design.md` that still says 4-u32-padded.

---

## 4. Precision — push usable depth past ~45 (open-ended, platform-gated)

The ~45 ceiling is **structural**: double-single (two f32) yields ~46 effective mantissa
bits (cf. luma.gl `fp64`: ~46 bits, ~1e-15 rel. error). Our measured ceiling matches almost
exactly — it is the mantissa limit, not a bug. The paper reaches depth 63 with **native FP64**,
which WGSL does not have (gpuweb/gpuweb#2805 is open, "Milestone 4+", no timeline — a sibling
1:1 planet renderer, CosmosJourneyer#514, hit the identical wall and chose the same df64
fallback). So depth-60 parity is gated by the platform. Within those limits:

### 4.1 LEB matrix cache  *(lifts usable depth toward 60, classic port)*

- Port the reference `leb_matrix_cache.{h,cpp}`: decode in `O(depth/5)` matrix steps instead
  of `O(depth)` per-step df64 — fewer accumulated rounding steps **and** cheaper.
- **Files.** `ocbt_eval_leb.wgsl` / `.ts` + the f64 eval compute shaders.
- **Payoff.** Both precision (fewer error-accumulating steps) and perf at deep zoom.

### 4.2 df64 the noise-domain coordinate (not the whole fBm)  *(suspect #2 for the ceiling)*

- **Hypothesis.** df64 fixes the *position* decode, but the fBm noise is sampled in **f32**
  on the unit direction. CosmosJourneyer#514 locates precision loss in the *height-field*
  compute, not only position. At deep zoom, adjacent vertices' f32 `dir` may not resolve
  finely enough → high-frequency detail smears **independently** of the position fix.
- **Approach.** First **trace where noise is sampled** and whether its domain coordinate is
  the next precision bottleneck after decode. If so, carry only the **domain coordinate** in
  df64 (keep the fBm body in f32). luma.gl warns full-df64 transcendentals are >10× f32 — be
  surgical: their own guidance is "target accuracy-critical paths only."
- **Building blocks.** luma.gl `fp64` (`add/sub/mul/div/sqrt/exp/log/sin/cos_fp64`) is a
  proven reference op-set to port if we need transcendentals we don't have yet.

### 4.3 Watch native f64 / consider triple-single  *(long-horizon)*

- Track gpuweb/gpuweb#2805; if `f64` lands in WGSL, the camera-relative decode collapses to
  native double and the ~45 ceiling lifts to ~depth-52+ directly.
- The only *emulated* way past df64 is **triple-single** (3 f32, ~70 bits) — expensive, but
  the sole path to true depth-60 without native FP64. Prototype only if a concrete use case
  demands sub-45 depth before the platform delivers f64.

---

## 5. Dropped by design (do **not** revisit without a new requirement)

World42 = fixed octahedron, one planet per source, forward rendering. The reference's
half-edge loader, FFT ocean, impostors, deferred visibility-buffer, and elevation textures
are intentionally **out of scope** — deformation is analytic (`cbt_noise.wgsl`).

---

## Suggested order of attack

1. **§2.1** (compacted-draw VS gate) — small, safe, removes the one real render-robustness item.
2. **§3.5** (stale comments/doc) — trivial cleanup, do alongside §2.1.
3. **§3.3** (GPU frame-time numbers) — needed to prioritize everything else honestly.
4. **§1.1** (packed Reduce) — the dominant perf win; gated by golden tests.
5. **§3.2** (camera-metric stress tests) — before §3.4 and before §3.1 default flip.
6. **§1.3 → §1.2 → §1.4** (indirect EvalLeb/CopyNeighbors/Classify) — incremental floor removal.
7. **§3.4** (split+merge same frame) — after §3.2 gives the per-frame invariant gate.
8. **§3.1** (production selection) — once §3.3 numbers justify it.
9. **§4.1 → §4.2** (precision) — open-ended; §4.3 is a platform watch.
