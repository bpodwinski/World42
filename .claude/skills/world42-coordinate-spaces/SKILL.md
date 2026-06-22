---
name: world42-coordinate-spaces
description: Audit and enforce coordinate-space boundaries in World42 across WorldDouble, render-space, and planet-local data paths. Use when requests mention precision drift, wrong culling distances, broken teleport/camera placement, incorrect shader lighting vectors, or any edits in src/core/camera/, src/systems/lod/chunks/, src/game_world/stellar_system/, and ScaleManager conversions.
---

# World42 Coordinate Spaces

Enforce a strict space contract before changing logic. Prevent subtle bugs by keeping each computation inside one coordinate space and converting only at explicit boundaries.

## Workflow

### 1) Run a quick audit

Run:

```powershell
./.codex/skills/world42-coordinate-spaces/scripts/check-space-usage.ps1
```

Review:
- Canonical conversion API usage (`toRenderSpace`, `toWorldSpace`, `localToWorldDouble`)
- Unit conversion API usage (`ScaleManager`)
- Potential mixed-space hotspots (`camera.position` vs `camera.doublepos`)

### 2) Classify the target computation

Choose one space per formula:
- `WorldDouble`: absolute distances, culling/SSE, star and planet centers.
- `Render-space`: Babylon transform/frustum-facing values.
- `Planet-local`: worker mesh vertices and terrain shader-local vectors.

If inputs come from multiple spaces, convert first, then compute.

### 3) Apply conversion rules

- Use `camera.toRenderSpace(world, out)` for world-to-render conversion.
- Use `camera.toWorldSpace(render, out)` for render-to-world conversion.
- Use `ScaleManager` for km <-> sim conversions.
- Use `localToWorldDouble` or explicit pivot-matrix transforms for local <-> world.

Avoid implicit subtraction/addition across spaces when helper APIs already exist.

### 4) Verify invariants

Confirm:
- Distances and SSE read from `camera.doublepos`, not `camera.position`.
- Frustum checks operate in render-space after conversion.
- Worker payloads remain planet-local.
- Lighting direction conversions remain explicit around pivot matrices.

Use `references/space-contracts.md` and `references/conversion-checklist.md` for detailed checks.

## Resources

- Script: `scripts/check-space-usage.ps1`
- Reference: `references/space-contracts.md`
- Reference: `references/conversion-checklist.md`
