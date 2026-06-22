---
name: world42-lod-tuner
description: Tune and stabilize World42 CDLOD behavior, including split/merge hysteresis, scheduler frame budgets, worker pressure, and chunk culling decisions. Use when requests mention LOD popping, frame spikes, over-subdivision, delayed detail, chunk churn during camera motion, or edits under src/systems/lod/, src/app/setup_lod_and_shadows.ts, and related LOD constants.
---

# World42 Lod Tuner

Tune LOD with measurable changes, not guesswork. Collect a baseline first, classify the failure mode, change one control family at a time, then verify stability and frame-time impact.

## Workflow

### 1) Collect a baseline

Run:

```powershell
./.codex/skills/world42-lod-tuner/scripts/lod_metrics_scan.ps1
```

Record:
- Scheduler controls (`maxConcurrent`, `maxStartsPerFrame`, `budgetMs`, `rescoreMs`)
- Hysteresis controls (`sseSplitThresholdPx`, `sseMergeThresholdPx`)
- Culling prefetch scales and relief margin
- Worker defaults and mesh/noise settings

If metrics are missing, open the files listed by the script and update the scan patterns.

### 2) Classify the symptom

Use this quick mapping:
- Popping or oscillation near thresholds: tune hysteresis and guard bands.
- Large frame spikes while moving camera: tune scheduler budget and start rate first.
- Slow detail refinement but stable frame time: increase starts/concurrency carefully.
- Worker backlog or delayed chunk appearance: tune worker parallelism, job format, and dedup/cancel behavior.

### 3) Apply minimal tuning

Modify one family at a time:
- Hysteresis: keep `split > merge`; start with a 1.0 px gap.
- Scheduler: change `budgetMs`, then `maxStartsPerFrame`, then `maxConcurrent`.
- Prefetch: increase only when motion causes visible holes.

Prefer small deltas (10 to 25 percent). Avoid changing thresholds and budgets in the same commit unless necessary.

### 4) Verify before closing

Confirm:
- No split/merge ping-pong under steady camera.
- No visible holes during fast camera movement.
- Average frame time improves or remains stable.
- Worker queue does not grow without draining.

Add or update tests for touched logic when feasible, especially under `src/systems/lod/**`.

## Invariants

Enforce these invariants on every tuning pass:
- Keep coordinate spaces explicit (`WorldDouble`, render-space, planet-local).
- Keep hysteresis ordering: `sseSplitThresholdPx > sseMergeThresholdPx`.
- Keep a bounded frame budget; never remove `deadline` guards in LOD recursion.
- Keep async safety in chunk generation (`pendingMeshToken`, `disposedFlag`).

Read detailed rules in `references/lod-invariants.md` and recipes in `references/frame-budget-recipes.md`.

## Resources

- Script: `scripts/lod_metrics_scan.ps1`
- Reference: `references/lod-invariants.md`
- Reference: `references/frame-budget-recipes.md`
