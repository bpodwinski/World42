---
name: world42-cbt-mvp
description: Implement an MVP per-planet terrain LOD choice for World42 where each planet uses either CDLOD or CBT (never both at once). Use when requests mention Concurrent Binary Trees, large_cbt, triangle-area LOD, or selecting per-planet terrain algorithm in paths under src/systems/lod/, src/app/setup_lod_and_shadows.ts, src/game_world/stellar_system/, and camera-space contracts.
paper: "Concurrent Binary Trees for Large-Scale Game Components — HPG 2024 — https://arxiv.org/abs/2407.02215"
reference_impl: "https://github.com/AnisB/large_cbt (DX12/HLSL reference — see references/10_large_cbt_gpu_reference.md for WebGPU mapping)"
---

# World42 CBT MVP

Implement a minimal per-planet algorithm choice first: one planet is either `cdlod` or `cbt`, with no hybrid blending.

## MVP Goal

Deliver a working scene-level and planet-level choice:
- Planet A can run CDLOD.
- Planet B can run CBT.
- A single planet uses one algorithm at a time.

## Guardrails

- Keep coordinate-space boundaries explicit (WorldDouble, render-space, planet-local).
- Preserve current CDLOD behavior for planets configured as CDLOD.
- Keep rollout low-risk with feature flags and defaults.

## Workflow

### 1) Add per-planet algorithm config

Add a field on the planet runtime config:
- `lodAlgorithm: 'cdlod' | 'cbt'`

Default to `cdlod` when not provided.

### 2) Keep CDLOD path untouched

Do not refactor existing CDLOD internals during MVP.
Only route planets to existing CDLOD flow when `lodAlgorithm='cdlod'`.

### 3) Add minimal CBT path

Implement a basic CBT planet path:
- Classify by projected triangle area.
- Apply a split-first strategy (simplify can come later).
- Keep a conservative per-frame budget.

### 4) Route by planet in scene setup

In scene setup/orchestration:
- If planet config says `cdlod`, build the CDLOD tree.
- If planet config says `cbt`, build the CBT planet pipeline.

No cross-fade, no near/far mix for the same planet.

### 5) Validate

Run:

```powershell
./.codex/skills/world42-cbt-mvp/scripts/check-cbt-mvp-integration.ps1
npm run pw:validate
```

## Deliverables

- Per-planet LOD algorithm selection (`cdlod` or `cbt`).
- Working CBT MVP path for configured planets.
- No regressions for CDLOD planets.
- Implementation notes in `references/mvp-implementation-plan.md`.

## Resources

- Use `references/mvp-implementation-plan.md` for the end-to-end implementation sequence.
- Use `references/08_world42_mapping.md` to map CBT concepts to current World42 modules.
- Use `references/09_checklist.md` as a final review checklist.
- Use `references/10_large_cbt_gpu_reference.md` for the **authoritative GPU reference** — full kernel pipeline, memory layout, bitfield ops, HLSL→WGSL translation, and priority implementation roadmap from the paper's reference implementation.
- Use `scripts/check-cbt-mvp-integration.ps1` to inspect routing and coordinate-space touch points.

## Gap Summary (current World42 CBT vs paper)

The current implementation is correct on LOD metric and bisection but is a CPU stub:

| What's correct | What's missing |
|---|---|
| Bisection by longest edge | Heap-array + bitfield structure |
| Screen-space area LOD metric | Sum-reduction (prefix-sum tree) |
| Single-pass classify + merge | Neighbor table (no T-junction prevention) |
| Backside culling (Phase 2) | Incremental mesh (full rebuild each change) |
| Per-planet routing | GPU compute kernels (all 14) |
| Measured perf + regression harness | Indirect draw |

See `references/10_large_cbt_gpu_reference.md` § 7 for the priority GPU order, and
`references/11_cpu_optimization_results.md` for the CPU optimization harness and
measured results (Phases 0–3), plus the next CPU levers (merge-agg Map, noise
offload, typed-array heap).