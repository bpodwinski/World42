# Space Contracts

## WorldDouble

Use for:
- High-precision absolute positions (`doublepos`, `positionWorldDouble`)
- Distances used by LOD, culling, and priority
- Star and planet center vectors before render conversion

Avoid:
- Using render-space camera position for world distances

## Render-space

Use for:
- Babylon rendering transforms
- Frustum tests after converting world centers
- Visual debug nodes attached to the render graph

Canonical conversions:
- `camera.toRenderSpace(world, out)`
- `camera.toWorldSpace(render, out)`

## Planet-local

Use for:
- Worker-generated mesh buffers
- Patch centers/corners before world transforms
- Terrain shader local vectors (`uPatchCenter`, local light direction)

Canonical conversion path:
- local -> rotated by planet pivot matrix -> add planet center in WorldDouble

## Unit Contract

- km values from catalog must be converted via `ScaleManager`.
- Do not mix raw km constants with sim-space vectors in the same computation.

## Red Flags

- Formula reads both `camera.position` and `camera.doublepos`.
- Frustum or SSE logic consumes local coordinates without explicit conversion.
- Shader uniform naming says local but receives world or render vectors.
