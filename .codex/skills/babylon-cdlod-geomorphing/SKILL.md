---
name: babylon-cdlod-geomorphing
description: Implement and tune Babylon.js CDLOD terrain rendering with GPU vertex geomorphing, quadtree patch selection, crack prevention, and stable LOD transitions. Use when tasks mention terrain or planet LOD popping, cracks between tiles, patch churn, ShaderMaterial terrain displacement, or edits to quadtree LOD logic and terrain vertex shaders.
---

# Babylon.js CDLOD Geomorphing

Use this workflow to build or debug crack-free terrain LOD in Babylon.js.

## Execute this workflow

1. Define one reusable patch mesh and instance it.
- Use an odd grid resolution (`33`, `65`, `129`) so edge and center alignment stay stable.
- Keep terrain displacement in the vertex shader; avoid CPU vertex rewrites.

2. Build quadtree selection with stable split and merge logic.
- Select leaves by camera distance bands or screen-space error.
- Enforce hysteresis (`split < merge`) to stop LOD flicker near thresholds.
- Keep neighbor LOD delta at most 1 before rendering.

3. Compute geomorphing on the GPU from the same metric used for LOD thresholds.
- Blend from child-space to parent-space positions.
- Clamp `morphFactor` in `[0, 1]`.
- Align morph windows with your split ranges so transitions complete before handoff.

4. Prevent cracks at LOD boundaries.
- Prefer edge snapping for adjacent different-LOD tiles.
- Add skirts only as a fallback if edge snapping cannot guarantee closure.
- Avoid stitching variants unless topology constraints require them.

5. Verify behavior with explicit debug passes.
- Render LOD level colors.
- Render morph-factor heatmap.
- Toggle wireframe and patch bounds.
- Test camera strafes and altitude sweeps to expose oscillation.

## Babylon.js contract

Use `ShaderMaterial` (or equivalent node/compiled shader path) with these minimum inputs.

- Attributes: `position`, `uv`
- Uniforms: `viewProjection`, `cameraPosition`, `patchOffset`, `patchScale`, `lodLevel`, `morphStart`, `morphEnd`
- Samplers/textures: terrain height source (heightmap or procedural field lookup)

Keep CPU and shader coordinate spaces consistent before debugging LOD artifacts.

## Troubleshooting order

1. Fix split/merge hysteresis first.
2. Validate morph math against threshold distances.
3. Validate neighbor edge policy (snapping or skirts).
4. Profile worker/CPU traversal only after visual correctness is stable.

## Read references only when needed

- Use [references/terrain-lod-theory.md](references/terrain-lod-theory.md) when you need algorithm tradeoffs, artifact taxonomy, or formulas for screen-space error.

## Completion criteria

- LOD transitions remain smooth during camera motion.
- No visible cracks across patch boundaries.
- No repeated split/merge churn around the same camera distance.
- Frame time stays stable under normal traversal.
