# World42 AI Context

This file is the shared project context for both Codex and Claude. Keep it
vendor-neutral. Put tool-specific instructions in `AGENTS.md`, `CLAUDE.md`,
`.codex/`, or `.claude/`.

## Project Summary

World42 is a real-time 1:1 scale planetary rendering engine for moving from
surface altitude to orbit and interplanetary distances. It uses Babylon.js,
TypeScript, WebGPU/WebGL2, Web Workers, and a Rust/WASM terrain generator.

The project currently contains two terrain LOD families:
- CDLOD quad-sphere terrain for the existing production path.
- TERRAIN/TERRAIN terrain experiments for GPU topology and large-scale adaptive
  triangulation.

Per planet, use one terrain algorithm at a time. Do not mix CDLOD and TERRAIN on a
single planet unless the user explicitly asks for a transition experiment.

## Required Reading By Task

Read the relevant local context before editing these areas:
- Camera or precision: `src/core/camera/`, `src/core/scale/`.
- Coordinate conversions: `src/core/scale/scale_manager.ts`, camera helpers,
  and any local coordinate-space notes.
- CDLOD terrain: `src/systems/lod/chunks/`, `src/systems/lod/lod_scheduler.ts`.
- TERRAIN/TERRAIN terrain: `src/systems/lod/terrain/` and the TERRAIN skill/reference docs
  under `.codex/skills/world42-terrain/` or `.claude/skills/world42-terrain/`.
- Worker protocol: `src/systems/lod/workers/worker_protocol.ts`,
  `src/systems/lod/workers/terrain_mesh_worker.ts`, `terrain/src/lib.rs`.
- Terrain shaders: `src/assets/shaders/terrain/` and
  `src/game_objects/planets/rocky_planet/terrains_shader.ts`.
- Stellar catalog behavior: `src/game_world/stellar_system/`.

## Non-Negotiable Contracts

- Keep `ScaleManager` as the single point for km/simulation-unit conversion.
- Keep coordinate spaces explicit: WorldDouble, render-space, and planet-local.
- Workers receive and return planet-local terrain data.
- The main thread must not generate heavy terrain geometry.
- Preserve CDLOD behavior when changing TERRAIN/TERRAIN code, and preserve TERRAIN/TERRAIN
  behavior when changing CDLOD code.
- Keep TypeScript strict and avoid broad `any` usage.
- Keep source code, comments, identifiers, commit messages, and PR descriptions
  in American English.

## Validation Expectations

For repository modifications by an AI agent, run:

```bash
npm run pw:validate
```

The validation should open the app, capture a snapshot, capture a screenshot,
and leave artifacts under `output/playwright/`.

For logic-heavy changes, also run the most focused relevant tests first, then
broader tests if risk warrants it.

## Documentation Maintenance

- `AGENTS.md` should stay concise and operational.
- `CLAUDE.md` can remain the deeper Claude-oriented reference.
- `AI_CONTEXT.md` should contain shared facts and contracts, not model-specific
  behavior.
- If a concept appears in both Codex and Claude guidance, prefer moving the
  shared part here and keeping only tool-specific workflow notes in the
  tool-specific files.
