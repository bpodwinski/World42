# Frame Budget Recipes

## Symptom: split/merge flicker near camera threshold

Actions:
- Increase hysteresis gap first (`split - merge`).
- Keep prefetch scales moderate to avoid over-loading children early.

Safe starting range:
- `sseSplitThresholdPx`: `5.0` to `7.0`
- `sseMergeThresholdPx`: `3.5` to `5.5`

## Symptom: short frame spikes during fast movement

Actions:
- Lower `maxStartsPerFrame` before lowering `maxConcurrent`.
- Reduce `budgetMs` to cap worst-case CPU time.

Safe starting range:
- `maxStartsPerFrame`: `1` to `3`
- `maxConcurrent`: `2` to `8`
- `budgetMs`: `4` to `20`

## Symptom: chunks appear too late after movement

Actions:
- Increase `maxStartsPerFrame` gradually.
- Increase `rescoreMs` frequency (smaller value) only if reprioritization is lagging.
- Validate worker queue drains.

Safe starting range:
- `rescoreMs`: `80` to `250`

## Symptom: too many distant chunks generated

Actions:
- Lower prefetch scales.
- Recheck culling bounds (fallback vs `boundsInfo`).
- Keep `cullReliefMargin` realistic relative to terrain amplitude.

## Change Discipline

- Change one control family per commit.
- Re-measure after each change.
- Prefer 10 to 25 percent increments.
