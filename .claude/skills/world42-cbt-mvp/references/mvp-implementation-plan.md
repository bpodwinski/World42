# CBT MVP Implementation Plan (for AI Agents)

## Scope

Goal: ship a low-risk MVP where each planet is configured as either CDLOD or CBT.

- Keep CDLOD as stable baseline.
- Add CBT as optional per-planet algorithm.
- No hybrid near/far blend for the same planet in MVP.

## Phase Plan

### Phase 0 - Configuration

1. Add `lodAlgorithm` on planet runtime config (`cdlod | cbt`).
2. Default to `cdlod` if omitted.
3. Expose debug UI label per active planet showing algorithm.

Acceptance:
- Existing scenes run unchanged.
- A planet can be switched to CBT via config only.

### Phase 1 - CBT module skeleton

1. Add `src/systems/lod/cbt/`:
   - `cbt_scheduler.ts`
   - `cbt_state.ts`
   - `cbt_classify.ts`
   - `cbt_emit.ts`
2. Implement split-first update with frame budget.
3. Emit renderable triangle stream for one planet.

Acceptance:
- A CBT-configured planet renders and updates.
- No hard stalls under camera movement.

### Phase 2 - Scene routing by planet algorithm

1. In setup/orchestration, route each planet to either CDLOD builder or CBT builder.
2. Keep each planet bound to one algorithm per run.
3. Ensure disposal/lifecycle symmetry for both paths.

Acceptance:
- Mixed scene works (some planets CDLOD, some CBT).
- No duplicate pipeline for same planet.

### Phase 3 - Stability pass

1. Add simplify pass (optional but recommended).
2. Add neighbor propagation for crack safety.
3. Add counters: active triangles, splits/frame, simplify/frame, budget hits.

Acceptance:
- Reduced churn and fewer cracks in CBT mode.
- Predictable frame-time behavior.

### Phase 4 - Hardening

1. Add fallback to CDLOD if CBT init fails for a planet.
2. Add tests for routing and config defaults.
3. Add one stress scenario with multiple planets using different algorithms.

Acceptance:
- Fail-safe startup.
- Deterministic routing and stable rendering.

## Suggested World42 Touch Points

- `src/game_world/stellar_system/stellar_catalog_loader.ts`
  add optional `lodAlgorithm` in loaded body metadata.
- `src/app/setup_lod_and_shadows.ts`
  route planet creation by `lodAlgorithm`.
- `src/systems/lod/`
  keep `chunks/` for CDLOD, add `cbt/` for CBT.
- `src/core/camera/camera_manager.ts` consumers
  keep WorldDouble camera source (`camera.doublepos`) for both algorithms.

## Space and Unit Contract

- WorldDouble: camera/world distances and selection.
- Render-space: frustum/projection computations.
- Planet-local: generated geometry payloads.
- Convert once at boundaries, never mix spaces in one formula.

## MVP Non-Goals

- Hybrid near/far blend for one planet.
- Full parity with DX12 large_cbt implementation.
- Replacing CDLOD globally.

## Agent Execution Template

For each phase:
1. Implement minimal code path.
2. Run static audit script.
3. Run `npm run pw:validate`.
4. Report tested planet configs and artifacts path.
