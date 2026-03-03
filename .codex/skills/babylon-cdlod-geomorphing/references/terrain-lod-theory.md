# Terrain LOD Theory (CDLOD-Focused)

## Table of Contents

1. [Goal](#goal)
2. [Core Artifact Types](#core-artifact-types)
3. [Algorithm Selection](#algorithm-selection)
4. [CDLOD Runtime Model](#cdlod-runtime-model)
5. [Screen-Space Error](#screen-space-error)
6. [Crack Prevention](#crack-prevention)
7. [Stability Rules](#stability-rules)
8. [Planet-Scale Notes](#planet-scale-notes)

## Goal

Reduce rendered terrain complexity while preserving visual continuity and frame-time stability.

## Core Artifact Types

- Popping: abrupt topology change during LOD switch.
- Cracks: gaps at boundaries between mismatched LOD patches.
- Oscillation: repeated split and merge near the same threshold.

## Algorithm Selection

- ROAM: high adaptivity, CPU heavy, uncommon for modern GPU-first pipelines.
- Geomipmapping: simple fixed blocks, fast to ship, often needs crack workarounds.
- Chunked LOD: strong for precomputed static terrain datasets.
- CDLOD: strong fit for procedural or streamed terrain with shader displacement.
- Geometry clipmaps: strong for very large heightfield terrains with camera-centered rings.

## CDLOD Runtime Model

Use a quadtree of logical terrain nodes.

1. Evaluate visibility and LOD eligibility for each node.
2. Select renderable leaves.
3. Render each leaf by instancing a shared grid mesh.
4. Sample height/displacement in the vertex shader.
5. Morph vertices across transition ranges to hide hard switches.

Distance bands usually grow approximately by powers of two, for example:

- LOD0: 25 m
- LOD1: 50 m
- LOD2: 100 m
- LOD3: 200 m

## Screen-Space Error

Use projected error when distance-only thresholds are not stable enough.

```text
screenError =
(worldError * viewportHeight) /
(2 * tan(fov / 2) * depth)
```

Prefer lower-detail nodes when `screenError` is below target tolerance.

## Crack Prevention

- Edge snapping: align higher-detail border vertices to lower-detail edges.
- Skirts: add border geometry as a robust fallback when closure is uncertain.
- Stitch triangles: use only when strict topology constraints require explicit bridges.

## Stability Rules

- Use hysteresis: `splitDistance < mergeDistance`.
- Keep neighbor LOD difference to at most one level.
- Compute morph factor from the same metric used by selection thresholds.
- Avoid per-frame CPU vertex buffer rewrites.

## Planet-Scale Notes

- Keep coordinate-space boundaries explicit (double precision for world logic, float for render local).
- Apply floating-origin or local transforms before shader displacement.
- Validate culling and error metrics at orbit, atmosphere, and near-ground altitudes.
