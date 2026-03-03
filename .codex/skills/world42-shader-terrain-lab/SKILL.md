---
name: world42-shader-terrain-lab
description: Evolve and debug World42 terrain and atmosphere shaders safely, including GLSL uniform contracts, Babylon ShaderMaterial bindings, shadow integration, and LOD/UV debug modes. Use when changing files under src/assets/shaders/, src/game_objects/planets/rocky_planet/terrains_shader.ts, atmospheric postprocess code, or when visual artifacts appear in terrain lighting, shadows, or debug LOD rendering.
---

# World42 Shader Terrain Lab

Work from contract to effect: keep GLSL declarations, TS uniform/sampler lists, and runtime `set*` bindings in sync before tuning visual output.

## Workflow

### 1) Audit shader bindings

Run:

```powershell
./.codex/skills/world42-shader-terrain-lab/scripts/audit-shader-bindings.ps1
```

Use it to detect:
- Uniforms declared in GLSL but not declared in TS material/postprocess lists
- Uniforms declared but never set
- Runtime `set*` calls on names not declared in GLSL
- Sampler mismatches

### 2) Apply shader changes in lockstep

When adding/removing a uniform or sampler:
- Update GLSL declaration.
- Update TS `uniforms`/`samplers` arrays.
- Update runtime `set*` calls and default values.

Do this for both terrain shader and atmosphere postprocess paths.

### 3) Verify space assumptions

- Terrain shader local geometry logic remains planet-local (`vPosition`, `uPatchCenter`).
- Shadow projection inputs stay render-space (`vWorldPosRender` + `lightMatrix`).
- Lighting direction passed from chunk forge stays normalized and local as expected.

### 4) Validate visual debug modes

- Toggle `ChunkTree.debugLODEnabled` path and confirm `debugLOD` branch.
- Keep `debugUV` branch available for UV diagnostics.
- Recheck shadows after changing normal or world-position paths.

Use `references/shader-uniform-contracts.md` and `references/shader-debug-playbook.md`.

## Resources

- Script: `scripts/audit-shader-bindings.ps1`
- Reference: `references/shader-uniform-contracts.md`
- Reference: `references/shader-debug-playbook.md`
