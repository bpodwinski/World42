---
name: world42-cbt
description: World42's CBT/OCBT terrain-LOD knowledge and workflow. Every planet runs the single integrated, validated GPU pool-CBT (OCBT) terrain engine. Use when requests mention Concurrent Binary Trees, OCBT, large_cbt, bisectors, triangle-area/screen-space LOD, or the GPU topology engine in paths under src/systems/lod/, src/app/setup_lod_and_shadows.ts, src/game_world/stellar_system/, and camera-space contracts.
paper: "Concurrent Binary Trees for Large-Scale Game Components — HPG 2024 — https://arxiv.org/abs/2407.02215"
reference_impl: "https://github.com/AnisB/large_cbt (DX12/HLSL reference — see references/10_large_cbt_gpu_reference.md for WebGPU mapping)"
---

# World42 CBT / OCBT terrain engine

The terrain-LOD knowledge base for World42's Concurrent Binary Tree path. There is one
terrain algorithm — the GPU pool-CBT (OCBT) engine — and **every** planet runs it. There
is no per-planet algorithm selection and no CDLOD anymore.

## Current state (what this skill now covers)

This started as an MVP ("one planet CDLOD, another CBT, CBT as a CPU stub"). It has since
grown well past that — CDLOD has been fully removed, and the CBT path is now the **sole**
terrain backend: a fully integrated **GPU pool-CBT (OCBT)** engine
(Benyoub & Dupuy, HPG 2024): the CBT is a fixed-capacity memory-pool allocator and the
triangulation is stored as **explicit bisectors**, so per-frame cost and memory are
**decoupled from subdivision depth**.

Status of the OCBT engine:
- Concurrent GPU topology (split + merge) ported and **proven watertight** against the CPU
  oracle (20/20 GPU-vs-oracle cross-check).
- Render path live behind `?terrain=terrain`: df64 camera-relative decode, frustum culling, draw
  compaction, indirect dispatch of the work-list passes.
- Crack-free render to ~level 27 at the surface; usable-depth ceiling ~45 (emulated df64),
  structural hard cap 60 (u64 heap id).
- Remaining work is **performance** (kill the `O(capacity)` floor), **precision** (push
  past ~45), and **productionization** (promote from dev-only) — see
  `references/15_ocbt_future_work.md`.

The cpu and gpu-implicit backends have been removed; `terrainType` is now the single value
`'gpu-terrain'` in `terrain_scheduler.ts`, and the GPU OCBT engine
(`src/systems/lod/terrain/gpu/`) is the only runtime path. The CPU mirror still exists, but
only as the test **oracle**, not as a runtime backend.

## Guardrails

- Keep coordinate-space boundaries explicit (WorldDouble, render-space, planet-local).
- All planets run the single GPU OCBT engine — there is no per-planet algorithm choice.
- Validation = **geometry, not labels**: GPU and CPU oracle use different heap-id conventions,
  so compare decoded vertices / neighbor reciprocity / watertightness, never raw slot ids.
- Keep rollout low-risk with feature flags and defaults (`?terrain=terrain` dev override;
  `terrainType` is the single value `'gpu-terrain'`).

## Terrain pipeline (single engine, all planets)

- There is no per-planet algorithm selection: every planet builds the GPU OCBT pipeline in
  scene setup (`setup_lod_and_shadows.ts`, `stellar_catalog_loader.ts`).
- Subdivision is still governed by the screen-space-error / projected-area budget classifier
  (conservative per-frame budget) — that classifier drives split/merge, not a backend choice.

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

The original MVP delivered per-planet CDLOD/CBT routing with a **CPU-stub** CBT (correct
bisection + screen-space-area metric + neighbor conformity + typed-array pool, but no GPU
kernels or indirect draw). That stage is captured in `references/mvp-implementation-plan.md`
and `references/11_cpu_optimization_results.md`. It has been superseded by the GPU OCBT engine
above; the CPU mirror now serves as the **test oracle**, not the runtime path.
