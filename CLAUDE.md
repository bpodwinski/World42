# CLAUDE.md — World42 Reference Guide

> **Shared agent rules:** Read `@AGENTS.md` first. It defines the common
> Codex/Claude entry points and points to `AI_CONTEXT.md` for vendor-neutral
> architecture contracts. Keep Claude-specific workflow notes in this file.

> **Language rule:** All source code, comments, identifiers, commit messages, PR descriptions, and this file must be written in **American English**. No French anywhere in the codebase.

> **Playwright rule:** Always use Playwright in **headed** mode. Never headless. Applies to all browser automation in this project (visual tests, WebGPU checks, performance observations).

> **AI Memory:** Canonical memory lives in `.claude/memory/` (committed, exportable). Read `MEMORY.md` there at the start of any session. When writing a new memory entry, write it to `.claude/memory/` **and** mirror it to the system-level path (`~/.claude/projects/d--Dev-World42/memory/`) for auto-loading.

## Overview

**World42** is a real-time 1:1 scale planetary rendering engine designed to explore planetary surfaces at any altitude (ground level to orbit). Terrain is rendered with a single GPU LOD engine — **OCBT** (a *pool-CBT*: a Concurrent Binary Tree used as a fixed-capacity GPU memory-pool allocator, after Benyoub & Dupuy, HPG 2024) — on a quad-sphere, paired with a **floating-origin camera** that preserves numerical precision at interplanetary scale.

- **Version:** 0.0.5
- **Live demo:** https://bpodwinski.github.io/World42/
- **Type:** Static SPA (no server, no database) — **WebGPU required** (the terrain runs as WebGPU compute; there is no WebGL2 fallback)

> **History:** an earlier CDLOD quadtree path (CPU `ChunkTree` + WASM mesh workers) has been **fully removed**. OCBT is now the sole terrain path. Any doc/skill that still mentions `chunks/`, `workers/`, `mesh-kernel`, or CDLOD describes deleted code.

---

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| 3D rendering | BabylonJS (Frame Graph, WebGPU) | 9.14 |
| Main language | TypeScript (strict) | ESNext |
| GPU compute / shaders | WebGPU + WGSL | — |
| Options menu | Tweakpane | 4.0 |
| Bundler | Rspack | 2.1 |
| Tests | Vitest | 4.1 |
| Deployment | GitHub Pages | — |

> A legacy Rust crate lives in `terrain/` (`src/lib.rs`). It is **not** on the active path — terrain geometry is generated entirely on the GPU (WGSL compute). Treat `terrain/` as historical unless a task explicitly revives it.

---

## Dev Commands

> **Task runner:** a root `justfile` wraps the common workflows (`just --list` to see them).
> It is a thin façade — the `package.json` scripts remain the source of truth (CI, `npm ci`);
> `just` only adds descriptions and argument passthrough. Prefer it for day-to-day work:
> `just dev`, `just hud`, `just test`, `just probe --scenario ground-drift`,
> `just bench-flight --label before`, `just pw screenshot`. Long-running helpers (the GPU HUD
> bridge) stay as `scripts/*.ps1` / `*.mjs`; `just`/npm only launch them.

```bash
npm run serve       # Dev server → http://localhost:19000
npm run build       # Production build → /dist
npm run deploy      # Deploy to GitHub Pages (requires a prior build)
npm test            # Vitest (watch mode)
npm run coverage    # Coverage report (text + HTML in /coverage)
npm run bench       # Microbenchmarks (vitest bench)
npm run gpu:hud     # GPU HUD bridge (nvidia-smi → public/gpu_stats.json) — run before dev/perf
```

> **Important:** Skybox assets are loaded from `process.env.ASSETS_URL`. Create a `.env` file at the root with `ASSETS_URL=...` and `SCALE_FACTOR=...` before starting the dev server.

---

## Layered Architecture

Dependencies flow in one direction only (downward): **core ← systems ← game_world ← app**.

```
src/
├── core/               # Reusable engine subsystems (no game/domain dependencies)
│   ├── camera/         # OriginCamera (floating-origin), teleport_entity
│   ├── control/        # MouseSteerControlManager (6DOF ship controls)
│   ├── gui/            # GuiManager + components/ (crosshair, speed HUD, perf HUD)
│   ├── io/             # TextureManager (KTX2), star_catalog
│   ├── lifecycle/      # DisposableRegistry (deterministic teardown)
│   ├── render/         # EngineManager (WebGPU), Frame Graph + tasks, FSR1, atmosphere, stars
│   └── scale/          # ScaleManager — ONLY conversion point km ↔ sim
│
├── systems/            # Reusable systems (depend on core)
│   └── lod/
│       └── terrain/    # OCBT terrain engine
│           ├── terrain_scheduler.ts   # per-frame visibility cull + budgeted compute
│           ├── terrain_classify.ts    # screen-space-error LOD metric
│           ├── terrain_state.ts / terrain_emit.ts / terrain_noise.ts / terrain_lod.ts
│           ├── terrain_quality.ts     # quality presets (mesh density / depth)
│           └── gpu/    # WebGPU back end: pool, topology kernel, EvaluateLEB,
│                       #   df64/u64 emulation, render material, source
│
├── game_world/         # Game logic / catalog (depends on core + systems)
│   └── stellar_system/
│       ├── data.json                   # Sol + Alpha Centauri + Dev catalog
│       ├── stellar_catalog_loader.ts   # JSON → FloatingEntity + terrain runtime
│       ├── stellar_catalog_normalizer.ts
│       ├── planet_profiles.ts          # terrain archetypes (selena/mars/terra/ice/lava)
│       ├── planet_lighting.ts          # BRDF/albedo resolve over planet_lighting.json
│       ├── terrain_param_schema.ts     # options-menu parameter schema
│       └── terrain_profile_store.ts    # localStorage per-profile overrides
│
├── app/                # Top orchestration layer (depends on everything below)
│   ├── bootstrap_scene.ts            # scene, camera, GUI, catalog load, spawn
│   ├── setup_lod_and_shadows.ts      # builds terrain runtimes + TerrainScheduler
│   ├── setup_runtime.ts              # Frame Graph, HUD, controls, render loop
│   ├── create_floating_camera_scene.ts  # wires the above + the options menu
│   ├── terrain_options_menu.ts       # Tweakpane menu (key O), hot-rebuild
│   └── bench_flight.ts               # deterministic ground→orbit bench driver
│
├── assets/shaders/     # WGSL
│   ├── terrain/engine/ # CBT pool, topology compute passes, EvaluateLEB, df64 noise
│   ├── terrain/gpu/    # f32 noise, heap views, render-side helpers
│   ├── atmosphere/     # single-scattering atmosphere
│   ├── stars/          # star ray-march + starfield
│   └── fsr1/           # FSR1 EASU + RCAS upscaling
├── app.ts              # FloatingCameraScene.CreateScene() → createFloatingCameraScene
├── index.ts            # entry point: EngineManager.Create → CreateScene
├── types/              # TypeScript declarations (.d.ts)
└── utils/              # Misc utilities (sun_glare, etc.)
```

---

## Coordinate Spaces (Golden Rule)

There are **three distinct spaces**. Any computation must use **one space only**. Conversion must be **explicit** via `ScaleManager` or camera methods.

### WorldDouble (sim units)
- **What:** High-precision absolute position in simulation units
- **Where:** `camera.doublepos`, `entity.doublepos`, `body.positionWorldDouble`
- **Used for:** LOD metric (screen-space error), horizon/backside culling, inter-body distances
- **Convert from km:** `ScaleManager.toSimulationUnits(km)`

### Render-space (sim units)
- **What:** Camera-relative space — camera is always at (0, 0, 0)
- **Where:** `mesh.position`, `camera.position` (≈ 0), frustum planes
- **Used for:** GPU rendering, frustum culling, post-processing
- **Convert:** `camera.toRenderSpace(worldDouble, out)` or `worldDouble - camera.doublepos`

### Planet-local (sim units)
- **What:** Origin at planet center, axes aligned with rotation
- **Where:** GPU topology/EvaluateLEB outputs (vertices, bounds), shader uniforms (`uCamAnchor`, `uCamDelta`, `uLightDirection`)
- **Convert to WorldDouble:** `inversePivotMatrix * (worldDouble - planetCenter)`

### Enforcement Rules
- Never mix km and sim units in the same computation
- Always go through `ScaleManager` for any conversion (no magic constants)
- The GPU receives positions in planet-local (df64 camera-relative) and renders in planet-local
- `TerrainScheduler` reads only `camera.doublepos` (WorldDouble) for its LOD/cull decisions

---

## Critical Files

| File | Role |
|------|------|
| `src/index.ts` | Bootstrap: creates the WebGPU engine and launches the scene |
| `src/app.ts` | `FloatingCameraScene.CreateScene()` → `createFloatingCameraScene` |
| `src/app/bootstrap_scene.ts` | Scene/camera/GUI, loads `data.json`, spawns the start body |
| `src/app/setup_lod_and_shadows.ts` | Builds per-planet terrain runtimes + `TerrainScheduler`; `rebuildProfile` (hot-rebuild) |
| `src/app/setup_runtime.ts` | Frame Graph wiring, perf HUD, controls/teleport, FSR1 render-scale setter, render loop |
| `src/app/terrain_options_menu.ts` | Tweakpane options menu (key **O**); per-profile edits + global Render (FSR1) folder |
| `src/core/camera/camera_manager.ts` | `OriginCamera` — `doublepos`, `toRenderSpace`, floating-origin fold |
| `src/core/scale/scale_manager.ts` | **Single point** of km ↔ sim conversion (SCALE_FACTOR env) |
| `src/core/render/frame_graph.ts` | `attachFrameGraph` — the whole render pipeline as a Babylon 9 Frame Graph |
| `src/core/render/terrain_compute_task.ts` | Frame Graph task that drives the OCBT compute before the scene render |
| `src/core/render/fsr1_postprocess.ts` | FSR1 EASU + RCAS upscaling tasks |
| `src/core/render/atmosphere_postprocess.ts` / `star_raymarch_postprocess.ts` | Atmosphere + star Frame Graph tasks |
| `src/systems/lod/terrain/terrain_scheduler.ts` | Visibility cull (observable) + budgeted round-robin compute (graph task) |
| `src/systems/lod/terrain/gpu/terrain_topology_kernel.ts` | CBT pool topology: split/merge, EvaluateLEB, compaction, indirect dispatch |
| `src/systems/lod/terrain/gpu/terrain_source.ts` | Per-frame uniforms + re-bake gate; owns the render material + kernel |
| `src/systems/lod/terrain/gpu/terrain_render_material.ts` | Runtime-generated terrain shader (baked `TERRAIN_*` header + BRDF) |
| `src/game_world/stellar_system/stellar_catalog_loader.ts` | Loads `data.json`, creates `FloatingEntity` + terrain runtime per body |
| `src/game_world/stellar_system/planet_profiles.ts` | Terrain archetypes + `resolveProfile` (noise + craters + lighting + LOD) |
| `src/game_world/stellar_system/data.json` | Sol (8 planets) + Alpha Centauri + Dev system catalog |
| `src/assets/shaders/terrain/engine/` + `terrain/gpu/` | WGSL: CBT pool, topology passes, EvaluateLEB, df64/f32 noise, render helpers |

---

## Key Systems

### Floating-Origin Camera (`OriginCamera`)
- `doublepos`: high-precision absolute position (WorldDouble)
- Each frame: accumulates the render delta → `doublepos`, then resets render position to the origin ("the fold")
- Methods: `toRenderSpace(wd, out)`, `toWorldSpace(renderPos)`, `distanceToSim(wd)`
- `FloatingEntity`: entity whose `node.position` is recomputed in render-space each frame
- Under a Frame Graph, `onBeforeActiveMeshesEvaluationObservable` is re-fired manually so the fold still runs (see `setup_runtime.ts`).

### OCBT Terrain Engine (`TerrainScheduler` + GPU kernel)
- **What:** a Concurrent Binary Tree used as a **fixed-capacity GPU memory pool**; the triangulation is stored as explicit **bisectors**, so per-frame cost and memory are **decoupled from subdivision depth**.
- **GPU per frame:** topology (split/merge against the pool) → EvaluateLEB (df64 camera-relative vertex decode) → draw compaction → indirect dispatch of the work-list.
- **LOD metric:** screen-space error (`terrain_classify.ts`) drives split/merge.
- **Precision:** emulated double (`df64`) gives ~cm relief near the ground; crack-free to ~level 27 at the surface, usable depth ceiling ~45, structural cap 60 (u64 heap id).
- **Scheduler:** the cheap visibility/frustum cull runs in a scene observable (before active-mesh evaluation); the heavy compute runs as a **Frame Graph task** (`terrain_compute_task.ts`). The scheduler tick drives compute during the brief startup transient, then `onGraphReady` hands ownership to the task (no double-tick). `TerrainScheduler` options: `budgetMs`, `frustumCull`.
- **CPU mirror** (`gpu/terrain_cpu_mirror.ts` + tests) is the validation **oracle**, not a runtime path.

### Render Pipeline — Babylon 9 Frame Graph (`attachFrameGraph`)
Single command encoder, HDR until tonemap. Task order:

```
clear → terrain compute → sceneRender (terrain + skybox) → star ray-march →
[atmosphere] → TAA (16x) → bloom → ACES tonemap → FXAA →
[FSR1 EASU + RCAS | sharpen] → GUI → copy to backbuffer
```

- **Single-sample (no MSAA):** WebGPU cannot resolve a depth attachment via a render-pass resolve target, so MSAA was dropped; geometric AA is handled by always-on TAA + FXAA. The star pass samples single-sample depth directly for terrain occlusion.
- **FSR1 spatial upscaling:** the scene + all intermediate passes render at `renderScale` of the backbuffer, then EASU+RCAS upscale to full res. `renderScale` is **live-tunable from the options menu** (Render folder) and persisted to localStorage; changing it rebuilds the graph (render targets are sized at build time).
- **No shadow maps.** Lighting is per-pixel BRDF inside the terrain fragment shader (`terrain_render_material.ts`): Lommel-Seeliger + opposition surge + Cook-Torrance specular + curvature AO, gated by a `uPerfMask`. See the `world42-ocbt-lighting` skill for the full contract.

### Profiles & Options Menu
- **Profiles** (`planet_profiles.ts`): terrain archetypes by surface *type* (Space-Engine style, not per-planet) — `selena` (airless rocky / the dev Moon), `mars`, `terra`, `ice`, `lava`. `resolveProfile` bundles noise + craters + lighting + LOD. A body in `data.json` references a profile by id (`"profile": "selena"`).
- **Menu** (key **O**, `terrain_options_menu.ts`): auto-generated from `terrain_param_schema.ts`; edits persist per profile to localStorage (`terrain_profile_store.ts`). "Apply" **hot-rebuilds** the affected planets in place via `lod.rebuildProfile` (no reload). A global **Render** folder exposes the FSR1 render scale (applies live).

### Player Controls (6DOF)
- **Mouse:** yaw/pitch with a dead zone and response curve (no pointer-lock; reads absolute canvas position)
- **Keyboard:** Z/S (forward/back), Q/D (strafe), R/F (up/down), E/A (roll)
- **Modifiers:** Shift (boost), Ctrl (brake)
- **Debug keys:** **W** wireframe · **X** LOD coloring · **M** BabylonJS Inspector (lazy-loaded) · **T** teleport to Alpha Centauri · **P** perf HUD · **O** terrain options menu

---

## Development Pipeline

### Dev System (pilot planet)

The `Dev` system in `data.json` is the **reference target** for all terrain/shader/lighting iterations. Never validate a visual change on Sol or AlphaCentauri without first validating it here.

| Body | Role |
|------|------|
| `DevStar` | Sun clone — identical Earth-distance lighting, reproducible |
| `Moon` | Pilot planet — gray airless surface, `selena` profile (albedo 0.07, ø 3,474 km) |

**Why the Moon:**
- Simple surface (no atmosphere, no vegetation) → isolates pure terrain/lighting artifacts
- Small size → LOD converges quickly during dev
- Visible opposition surge and grazing shadows → good BRDF test bench

**Current state (CBT branch):**
- `"default": "Dev"` — active, the normal working state on this branch
- Reset to `"default": "Sol"` before merging to `main`

**Rule:** prototype any new lighting/terrain parameter on `Moon` (profile `selena`) first, then propagate to other profiles.

---

## Code Conventions

### Formatting (Prettier)
```json
{ "semi": true, "trailingComma": "none", "singleQuote": true, "printWidth": 80 }
```

### Indentation (EditorConfig)
- TypeScript/JavaScript: **4 spaces**
- Other files: 2 spaces
- Line endings: LF, charset UTF-8

### TypeScript
- `strict: true` required
- Target `ESNext`, moduleResolution `Node`
- `noImplicitReturns: true`
- No unjustified `any`

### Architecture Rules
- Dependencies always flow downward (core ← systems ← game_world ← app)
- `ScaleManager` is the **only** place where km/sim conversion constants are defined
- One computation = one coordinate space (no implicit mixing)
- The main thread must not generate geometry — terrain geometry is produced by the GPU compute engine
- WGSL shader constants are baked at runtime via the `TERRAIN_*` header (`terrain_render_material.ts` / topology kernel); changing a baked constant requires a material rebuild (the menu's "Apply" does this)

---

## Tests

- **Framework:** Vitest (`vitest.config.ts`), Node environment (no DOM)
- **Coverage:** `src/**/*.{ts,tsx}` → text + HTML report
- **What is covered:** the CBT pool allocator, u64/df64 emulation, LEB decode, the full CPU topology oracle + adversarial stress, noise (incl. a golden snapshot), `planet_lighting`, and `ScaleManager` conversions
- **Commands:**
  ```bash
  npm test              # watch mode
  npm run coverage      # report in /coverage/index.html
  ```
- **Golden snapshot:** if you intentionally change the noise baseline, regenerate with `npx vitest run -u` (`terrain_golden.test.ts`).
- WGSL is **not** compiled by tsc/Vitest — shader changes are only fully verified by loading the app in a WebGPU browser. Confirm the dev bundle is fresh after a `.ts`/`.wgsl` edit: `curl -s http://localhost:19000/index.js | grep -c <marker>`.

---

## Project Status and Priorities

### Working
1. Floating-origin — precision maintained at 1:1 scale
2. OCBT GPU terrain — topology + EvaluateLEB + compaction + indirect dispatch, cost decoupled from depth
3. `TerrainScheduler` with frame budget + round-robin; compute owned by the Frame Graph task
4. Centralized `ScaleManager` — unified km ↔ sim conversion
5. Render pipeline as a Babylon 9 Frame Graph (single-sample, TAA+FXAA, ACES, bloom)
6. FSR1 upscaling — live render-scale control from the options menu, persisted
7. Single-scattering atmosphere + star ray-march as Frame Graph tasks
8. Terrain profiles + in-game options menu (Tweakpane) with per-profile localStorage overrides and hot-rebuild
9. Multi-stellar catalog (Sol, Alpha Centauri, Dev) from JSON

### Open work (OCBT roadmap)
| Theme | Item |
|-------|------|
| **Performance** | Kill the `O(capacity)` per-frame floor (eval/compact over the full pool) |
| **Precision** | Push usable depth past ~45 (df64 limits near the surface) |
| **Productionization** | Promote the engine from dev defaults; per-planet rotation wired into `uLightDirection` |
| **Rendering** | Frame-graph depth is not sampleable → atmosphere/star occlusion uses an analytic sphere (TODO) |

---

## Deployment

**Automated via GitHub Actions** — `.github/workflows/deploy.yml` ("Build and Deploy") runs on
**push to `main`** (or manual `workflow_dispatch`). There is no `npm run deploy` / `gh-pages`
step anymore. The workflow:

1. `npm ci` + `npm run build` → the app (Rspack) into `dist/`
2. `npm ci` + `npm run build` in `website/` → the Rspress docs into `website/doc_build/`
3. Assembles `_site/` = **app at root, docs at `/docs/`**, then publishes via `actions/deploy-pages`

```
Demo: https://bpodwinski.github.io/World42/        (app)
Docs: https://bpodwinski.github.io/World42/docs/    (Rspress)
```

CI requirements (do not break these or the deploy fails):
- **`package-lock.json` (root + `website/`) must be committed** — `npm ci` needs them. They are
  intentionally tracked (see `.gitignore`).
- **`.npmrc` sets `legacy-peer-deps=true`** — required for the html-webpack-plugin × `@rspack/core@2`
  peer conflict, honored by CI's plain `npm ci`.
- **`npm run build` must exit 0** — the BabylonJS Inspector is gated out of production via the
  build-time `__DEV__` flag, so a green local `npm run build` matches CI.

`main` is the published line; **`CBT` is the active development branch** and does not deploy on its own.
Assets (KTX2 skybox) load from `process.env.ASSETS_URL` — configure in `.env`.
