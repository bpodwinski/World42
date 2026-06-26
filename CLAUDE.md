# CLAUDE.md — World42 Reference Guide

> **Language rule:** All source code, comments, identifiers, commit messages, PR descriptions, and this file must be written in **American English**. No French anywhere in the codebase.

## Overview

**World42** is a real-time 1:1 scale planetary rendering engine designed to explore planetary surfaces at any altitude (ground level to orbit). It implements a CDLOD (Continuous Distance-based Level of Detail) quadtree system on a quad-sphere, with a floating-origin camera to maintain numerical precision at interplanetary scales.

- **Version:** 0.0.5
- **Live demo:** https://bpodwinski.github.io/World42/
- **Type:** Static SPA (no server, no database)

---

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| 3D rendering | BabylonJS | 9.14.0 |
| Main language | TypeScript (strict) | ESNext |
| Procedural terrain | Rust + wasm-bindgen | edition 2024 |
| Terrain noise | `noise` crate (Perlin/Simplex) | 0.9 |
| Bundler | Rspack | 1.5.8 |
| Tests | Vitest | 4.0.5 |
| GPU rendering | WebGPU (fallback WebGL2) | — |
| Deployment | GitHub Pages | — |

---

## Dev Commands

```bash
# TypeScript
npm run serve       # Dev server → http://localhost:19300
npm run build       # Production build → /dist
npm run deploy      # Deploy to GitHub Pages (requires a prior build)
npm test            # Vitest (watch mode)
npm run coverage    # Coverage report (text + HTML in /coverage)

# Rust/WASM (run from the terrain/ directory)
wasm-pack build --dev --target web --out-dir pkg     # WASM dev build
wasm-pack build --release --target web --out-dir pkg  # WASM release build
```

> **Important:** Skybox assets are loaded from `process.env.ASSETS_URL`. Create a `.env` file at the root with `ASSETS_URL=...` and `SCALE_FACTOR=...` before starting the dev server.

---

## Layered Architecture

Dependencies flow in one direction only (downward):

```
src/
├── core/               # Reusable engine subsystems (no game dependencies)
│   ├── camera/         # OriginCamera (floating-origin), FloatingEntity
│   ├── control/        # MouseSteerControlManager (6DOF ship controls)
│   ├── gui/            # GuiManager, crosshair, speed HUD
│   ├── io/             # TextureManager (KTX2), AssetLoader
│   ├── render/         # EngineManager, PostProcessManager, star ray-marching
│   └── scale/          # ScaleManager — ONLY conversion point km ↔ sim
│
├── systems/            # Reusable systems (depend on core)
│   └── lod/
│       ├── chunks/     # ChunkTree, chunk_metrics, chunk_forge, culling
│       ├── workers/    # WorkerPool, mesh-kernel/1 protocol, MinHeap
│       ├── lod_scheduler.ts
│       └── lod_priority_queue.ts
│
├── game_objects/       # Domain entities (depend on core + systems)
│   └── planets/rocky_planet/
│       ├── terrain.ts                              # RockyPlanet
│       ├── terrains_shader.ts                      # TerrainShader + TerrainShadowContext
│       └── atmospheric-scattering-postprocess.ts   # Rayleigh + Mie
│
├── game_world/         # Game logic (top layer)
│   └── stellar_system/
│       ├── data.json                   # Sol + Alpha Centauri + Dev catalog
│       └── stellar_catalog_loader.ts   # Parses JSON and creates scene
│
├── assets/shaders/     # GLSL (terrain vertex/fragment, stars, atmosphere)
├── types/              # TypeScript declarations (.d.ts)
└── utils/              # Misc utilities (sun_glare, etc.)

terrain/                # Rust crate compiled to WASM
└── src/lib.rs          # build_chunk() — main WASM export
```

---

## Coordinate Spaces (Golden Rule)

There are **three distinct spaces**. Any computation must use **one space only**. Conversion must be **explicit** via `ScaleManager` or camera methods.

### WorldDouble (sim units)
- **What:** High-precision absolute position in simulation units
- **Where:** `camera.doublepos`, `entity.doublepos`, `body.positionWorldDouble`
- **Used for:** LOD (SSE), backside/horizon culling, inter-body distances
- **Convert from km:** `ScaleManager.toSimulationUnits(km)`

### Render-space (sim units)
- **What:** Camera-relative space — camera is always at (0, 0, 0)
- **Where:** `mesh.position`, `camera.position` (≈ 0), frustum planes, shadows
- **Used for:** GPU rendering, frustum culling, post-processing, shadow maps
- **Convert:** `camera.toRenderSpace(worldDouble, out)` or `worldDouble - camera.doublepos`

### Planet-local (sim units)
- **What:** Origin at planet center, axes aligned with rotation
- **Where:** WASM worker outputs (vertices, bounds), shader uniforms (`cameraPosition`, `uPatchCenter`, `lightDirection`)
- **Convert to WorldDouble:** `inversePivotMatrix * (worldDouble - planetCenter)`

### Enforcement Rules
- Never mix km and sim units in the same computation
- Always go through `ScaleManager` for any conversion (no magic constants)
- Workers receive positions in planet-local and return meshes in planet-local
- The LOD scheduler (`LodScheduler`) reads only `camera.doublepos` (WorldDouble)

---

## Critical Files

| File | Role |
|------|------|
| `src/index.ts` | Bootstrap: initializes the engine (WebGPU/WebGL2) and launches the scene |
| `src/app.ts` | `FloatingCameraScene.CreateScene()` — orchestrates all systems |
| `src/core/camera/camera_manager.ts` | `OriginCamera` — doublepos, toRenderSpace, floating-origin |
| `src/core/scale/scale_manager.ts` | **Single point** of km ↔ sim conversion (SCALE_FACTOR env) |
| `src/systems/lod/chunks/chunk_tree.ts` | CDLOD node: split/merge/culling/worker request |
| `src/systems/lod/chunks/chunk_metrics.ts` | SSE computation and bounding sphere distance |
| `src/systems/lod/chunks/chunk_forge.ts` | Builds BabylonJS mesh from worker data |
| `src/systems/lod/lod_scheduler.ts` | LOD tick with frame budget and multi-planet round-robin |
| `src/systems/lod/workers/worker_pool.ts` | Web Worker pool (hardwareConcurrency - 1) |
| `src/systems/lod/workers/terrain_mesh_worker.ts` | Worker entry point — `mesh-kernel/1` protocol |
| `src/systems/lod/workers/worker_protocol.ts` | Protocol types: init/build_chunk/chunk_result/cancel |
| `src/game_objects/planets/rocky_planet/terrains_shader.ts` | `TerrainShader` + shared `TerrainShadowContext` |
| `src/game_world/stellar_system/stellar_catalog_loader.ts` | Loads `data.json`, creates `FloatingEntity` + CDLOD |
| `src/game_world/stellar_system/data.json` | Sol (8 planets) + Alpha Centauri + Dev system catalog |
| `terrain/src/lib.rs` | `build_chunk()` WASM — generates positions/normals/uvs/indices |
| `src/assets/shaders/terrain/terrainVertexShader.glsl` | Vertex displacement, LOD blending |
| `src/assets/shaders/terrain/terrainFragmentShader.glsl` | Diffuse+detail texturing, PCF3x3 shadows |

---

## Key Systems

### Floating-Origin Camera (`OriginCamera`)
- `doublepos`: high-precision absolute position (WorldDouble)
- Each frame: accumulates render delta → `doublepos`, resets render position to origin
- Methods: `toRenderSpace(wd, out)`, `toWorldSpace(renderPos)`, `distanceToSim(wd)`
- `FloatingEntity`: entity whose `node.position` is recomputed in render-space each frame

### CDLOD System (LodScheduler + ChunkTree)
- **Algorithm:** SSE (Screen-Space Error) — `ssePx = error * K / distance`
- **Thresholds:** split if `ssePx > 5.0px`, merge if `ssePx < 4.0px` (hysteresis)
- **Structure:** 6 cube faces (quad-sphere), recursive subdivision up to `maxLevel=12`
- **Resolution:** 96 vertices per side (~9,409 verts/chunk)
- **Culling:** frustum (with prefetch guard-band) + backside/horizon
- **Scheduler:** `onBeforeRenderObservable` + `budgetMs` + multi-planet round-robin
- **Tunable params:** `maxConcurrent=8`, `maxStartsPerFrame=2`, `rescoreMs=100`, `budgetMs=30`

### Workers and WASM
- **Protocol:** `mesh-kernel/1` — `init → ready`, `build_chunk → chunk_result`, `cancel`
- **Pool:** `WorkerPool` with `hardwareConcurrency - 1` threads
- **Priority queue:** min-heap by camera distance, periodic rescore
- **Returned data:** `Float32Array` (positions, normals, uvs) + `Uint32Array` (indices) + bounding sphere

### Render Pipeline
| Stage | Detail |
|-------|--------|
| Engine | WebGPU with WebGL2 fallback |
| Tone mapping | ACES |
| Bloom | BabylonJS built-in |
| Anti-aliasing | FXAA + MSAA 4x |
| Sharpen | Custom post-process |
| Stars | SDF ray-marching (100 steps) |
| Atmosphere | Rayleigh + Mie scattering (post-process) |
| Shadows | ShadowGenerator 4096px, PCF3x3, dynamic range (stable snapping) |

### Player Controls (6DOF)
- **Mouse:** Yaw/Pitch with dead zone (50px) and response curve
- **Keyboard:** Z/S (forward/back), Q/D (strafe), R/F (up/down), E/A (roll)
- **Modifiers:** Shift (boost), Ctrl (brake)
- **Debug shortcuts:** L (LOD visualization), ² (BabylonJS Inspector), T (teleport to Alpha Centauri)

---

## Development Pipeline

### Dev System (pilot planet)

The `Dev` system in `data.json` is the **reference target** for all terrain/shader/lighting iterations. Never validate a visual change on Sol or AlphaCentauri without first validating it here.

| Body | Role |
|------|------|
| `DevStar` | Sun clone — identical Earth-distance lighting, reproducible |
| `Moon` | Pilot planet — gray airless surface, albedo 0.07, ø 3,474 km |

**Why the Moon:**
- Simple surface (no atmosphere, no vegetation) → isolates pure terrain/lighting artifacts
- Small size → LOD levels load quickly during dev
- Visible opposition surge and grazing shadows → good BRDF test bench

**Current state (CBT branch):**
- `"default": "Dev"` — active, this is the normal working state on this branch
- Reset to `"default": "Sol"` before merging to `main`

**Rule:** any new lighting parameter (`albedo`, `brdf`, `terrain`) must be prototyped on `Moon` first before being propagated to other bodies.

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
- No unjustified `any` imports

### Architecture Rules
- Dependencies always flow downward (core ← systems ← game_objects ← game_world)
- `ScaleManager` is the **only** place where km/sim conversion constants are defined
- One computation = one coordinate space (no implicit mixing)
- The main thread must not generate geometry (delegate to workers)

---

## Tests

- **Framework:** Vitest (configured in `vitest.config.ts`)
- **Environment:** Node (no DOM)
- **Coverage:** `src/**/*.{ts,tsx}` → text + HTML report
- **Existing file:** `src/core/scale/scale_manager.test.ts` (unit conversions)
- **Commands:**
  ```bash
  npm test              # watch mode
  npm run coverage      # report in /coverage/index.html
  ```

---

## Project Status and Priorities

### Working Features
1. Floating-origin functional — precision maintained at 1:1 scale
2. Async terrain generation (Workers + WASM) — main thread never blocked
3. LodScheduler with frame budget and round-robin — no infinite loops
4. Centralized ScaleManager — unified km ↔ sim unit conversion
5. Typed worker protocol (`mesh-kernel/1`) with cancellation support
6. Multi-stellar systems (Sol, Alpha Centauri, Dev) from JSON catalog
7. Full post-processing pipeline (bloom, ACES, FXAA, atmosphere, shadows)
8. WebGPU compatibility with WebGL2 fallback

### Known Issues (open)

| Priority | Issue | Impact | Target |
|----------|-------|--------|--------|
| **P2** | `ChunkTree` has too many responsibilities | Side effects on any change | Split into `ChunkNode` + `ChunkMeshService` + `ChunkVisibility` + `ChunkLodMetric` |
| **P3** | One material per chunk (potentially) | High draw calls, GPU overhead | 1 material/planet shared via `onBindObservable` |
| **P4** | No worker deduplication | CPU waste, same chunks requested N times | `dedup` by `chunkKey` + queue cancel |

### Technical Roadmap
- Object pool for nodes (avoid excessive dispose calls)
- CPU heightmap via dedicated Web Worker
- GPU chunk generation via WebGPU compute shaders
- Texture streaming from the cloud
- Equirectangular UV projection in shaders
- Triplanar UV mapping in shaders
- Generation timeout based on camera speed (avoid loading on every small movement)

---

## Deployment

```bash
# 1. Production build
npm run build        # → /dist

# 2. Deploy to GitHub Pages
npm run deploy       # uses gh-pages -d dist

# Demo URL: https://bpodwinski.github.io/World42/
```

Assets (KTX2 skybox) are loaded from `process.env.ASSETS_URL` — configure in `.env`.
