---
name: world42-cbt
description: World42's CBT/OCBT terrain-LOD knowledge and workflow. Per planet a planet runs CDLOD or a Concurrent Binary Tree (never both); the CBT side has grown from a CPU stub into an integrated, validated GPU pool-CBT (OCBT) engine. Use when requests mention Concurrent Binary Trees, OCBT, large_cbt, bisectors, triangle-area/screen-space LOD, the GPU topology engine, or selecting the per-planet terrain algorithm in paths under src/systems/lod/, src/app/setup_lod_and_shadows.ts, src/game_world/stellar_system/, and camera-space contracts.
paper: "Concurrent Binary Trees for Large-Scale Game Components — HPG 2024 — https://arxiv.org/abs/2407.02215"
reference_impl: "https://github.com/AnisB/large_cbt (DX12/HLSL reference — see references/10_large_cbt_gpu_reference.md for WebGPU mapping)"
---

# World42 CBT / OCBT terrain engine

The terrain-LOD knowledge base for World42's Concurrent Binary Tree path. Per planet, a
planet runs **either** CDLOD **or** CBT — no hybrid blending on a single planet.

## Current state (what this skill now covers)

This started as an MVP ("one planet CDLOD, another CBT, CBT as a CPU stub"). It has since
grown well past that. The CBT path is now a fully integrated **GPU pool-CBT (OCBT)** engine
(Benyoub & Dupuy, HPG 2024): the CBT is a fixed-capacity memory-pool allocator and the
triangulation is stored as **explicit bisectors**, so per-frame cost and memory are
**decoupled from subdivision depth**.

Status of the OCBT engine:
- Concurrent GPU topology (split + merge) ported and **proven watertight** against the CPU
  oracle (20/20 GPU-vs-oracle cross-check).
- Render path live behind `?cbt=ocbt`: df64 camera-relative decode, frustum culling, draw
  compaction, indirect dispatch of the work-list passes.
- Crack-free render to ~level 27 at the surface; usable-depth ceiling ~45 (emulated df64),
  structural hard cap 60 (u64 heap id).
- Remaining work is **performance** (kill the `O(capacity)` floor), **precision** (push
  past ~45), and **productionization** (promote from dev-only) — see
  `references/15_ocbt_future_work.md`.

The three backends coexist via `cbtType: 'cpu' | 'gpu-implicit' | 'gpu-ocbt'` in
`cbt_scheduler.ts`. The implicit GPU CBT path (`src/systems/lod/cbt/gpu/`) stays intact as a
fallback and comparison baseline.

## Guardrails

- Keep coordinate-space boundaries explicit (WorldDouble, render-space, planet-local).
- Preserve current CDLOD behavior for planets configured as CDLOD.
- One planet uses one algorithm at a time — no cross-fade, no near/far mix on a single planet.
- Validation = **geometry, not labels**: GPU and CPU oracle use different heap-id conventions,
  so compare decoded vertices / neighbor reciprocity / watertightness, never raw slot ids.
- Keep rollout low-risk with feature flags and defaults (`?cbt=` override; `cbtType` enum).

## Per-planet selection (the original MVP contract, still in force)

- Planet runtime config carries the LOD algorithm; default to `cdlod` when unspecified.
- `cdlod` → build the existing CDLOD tree (do not refactor CDLOD internals here).
- `cbt`/OCBT → build the CBT planet pipeline (classify by projected area / screen-space error,
  conservative per-frame budget).
- Route by planet in scene setup (`setup_lod_and_shadows.ts`, `stellar_catalog_loader.ts`).

## Validate

```powershell
./.claude/skills/world42-cbt/scripts/check-cbt-mvp-integration.ps1
npm run pw:validate
```

Plus: `npm test` (pool allocator, u64/df64 emulation, LEB decode, full CPU topology oracle +
adversarial stress suite) and the dev cross-check page `ocbt-topo-test.html` (GPU vs oracle,
direct + indirect paths, 20/20).

## Resources

- `references/08_world42_mapping.md` — map CBT concepts to current World42 modules.
- `references/09_checklist.md` — final review checklist.
- `references/10_large_cbt_gpu_reference.md` — **authoritative GPU reference**: full kernel
  pipeline, memory layout, bitfield ops, HLSL→WGSL translation, priority roadmap.
- `references/11_cpu_optimization_results.md` — CPU optimization harness + measured results.
- `references/12_offthread_cbt_worker.md` — off-thread CBT worker notes.
- `references/13_gpu_cbt_webgpu.md` — implicit GPU CBT (WebGPU) path notes.
- `references/14_ocbt_gpu_topology_design.md` — **as-built OCBT design**: buffer/binding
  table, per-frame dispatch order, correctness/WebGPU risks, convention resolutions.
- `references/15_ocbt_future_work.md` — **OCBT improvement roadmap**: ranked backlog
  (performance / render robustness / productionization / precision), critique triage, and a
  suggested order of attack.
- `references/mvp-implementation-plan.md` — original MVP sequence (historical).
- `scripts/check-cbt-mvp-integration.ps1` — inspect routing and coordinate-space touch points.

## History (CPU-stub MVP — superseded)

The original MVP delivered the per-planet CDLOD/CBT routing with a **CPU-stub** CBT (correct
bisection + screen-space-area metric + neighbor conformity + typed-array pool, but no GPU
kernels or indirect draw). That stage is captured in `references/mvp-implementation-plan.md`
and `references/11_cpu_optimization_results.md`. It has been superseded by the GPU OCBT engine
above; the CPU mirror now serves as the **test oracle**, not the runtime path.
