![planet-quadtree-js-web-web-worker](https://github.com/user-attachments/assets/bbbdd36f-db09-4105-9a1c-66f747aadccc)

# World42

World42 is a high-performance, multithreaded planet rendering engine that leverages a quadtree structure to dynamically manage Levels of Detail (LOD) for planetary surfaces. The project uses Web Workers for heavy geometry calculations and a floating-origin system to maintain precision even at vast distances. World42 is designed to render detailed, textured planetary surfaces with efficient LOD management. It uses a custom quadtree structure to subdivide the planet's surface and dynamically update patches based on the camera's distance and movement. By offloading geometry calculations to Web Workers, the engine maintains a smooth, responsive user experience.

## Features
- Floating origin camera
- Real-scale planet (1:1)
- Quadsphere with a uniform mesh
- Asynchronous CDLOD/Quadtree using Web Workers

## Folder structure

```txt
World42/
│
├─ core/                     # Reusable engine subsystems (indépendants du jeu)
│  ├─ camera/                # OriginCamera, FloatingEntity, etc.
│  ├─ scale/                 # ScaleManager, conversions (km → sim units)
│  ├─ control/               # MouseSteerControlManager, input abstractions
│  ├─ render/                # PostProcessManager, shaders, WebGPU/WebGL setup
│  ├─ io/                    # TextureManager, AssetLoader, network utils
│  └── ...
│
├─ game_objects/             # High-level engine systems built *from core*
│  └─ planet/                # CDLOD / Quadtree / ChunkTree logic
│        └─ rocky_planet/
│              ├─ quadtree/
│              ├─ chunks/
│              ├─ terrain/
│              └─ shaders/
│
├─ game_world/               # Game-specific logic built on top of engine/
│  ├─ entities/              # Planet entities, moons, satellites, etc.
│  ├─ solar_system/          # Multi-planet orchestration (Mercure, Terre, etc.)
│  └─ ...
│
├─systems/
│  └─ lod/                   # Orchestrateur générique
│      ├─ LodController.ts   # Décide quels patches sont requis
│      ├─ LodMetrics.ts      # Erreurs écran, géo, hystérésis
│      ├─ LodScheduler.ts    # File de maj, budgets (ms/frames)
│      ├─ LodCache.ts        # Pool, eviction
│      └─ workers/           # Workers génériques (interfaces + impl par défaut)
│          ├─ LodWorker.ts
│          └─ worker-protocol.ts
│
│
├─ assets/                   # Non-code resources
│  ├─ textures/
│  ├─ models/
│  ├─ skyboxes/
│  ├─ shaders/
│  └─ ...
│
├─ utils/                  # Generic utilities (unit conversions, timing)
│  └─ log.ts
│
├─ screens/                  # Game states (e.g. SolarSystemScreen, MenuScreen)
│  ├─ solar-system-screen.ts
│  ├─ intro-screen.ts
│  └─ ...
│
├─ public/                   # Static assets served by the dev server
│

├─ main.ts                   # Entry point (creates Engine, Scene, Camera)
├─ app.ts                    # Initializes scene, event loop, GUI, etc.
```

## Demo
[https://bpodwinski.github.io/World42/](https://bpodwinski.github.io/World42/)
- Press L to display LODs
- Press ² to display BabylonJS debug layer

## Installation
### Prerequisites

- [Node.js](https://nodejs.org/)
- [npm](https://www.npmjs.com/)
- [Rspack](https://rspack.rs/)

**Clone the repository:**

   ```bash
   git clone https://github.com/bpodwinski/World42.git
   cd World42
   npm i
   ```

**Dev**

   ```bash
   npm run serve
   http://localhost:3000/World42/
   ```
