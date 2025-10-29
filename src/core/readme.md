# 🧠 Core Module

The **`core/`** directory contains all *foundational, reusable systems* that form the technical backbone of the World42 engine.  
These modules are **engine-level building blocks** — fully independent of any game logic, planet implementation, or rendering content.

Everything inside `core/` is designed to be **generic**, **reusable**, and **stateless** where possible.  
Game-specific systems (like LOD, quadtree management, or planetary shaders) belong in higher-level layers such as `systems/` or `game_objects/`.

## 📁 Directory Overview

| Folder | Description |
|:-------|:-------------|
| **camera/** | Floating-origin camera logic, extended Babylon.js cameras, spatial transformations, and precision handling. |
| **scale/** | Unit conversions and the `ScaleManager` for real-scale planetary distances (km ↔ simulation units). |
| **control/** | Input abstractions and control schemes, including `MouseSteerControlManager` for free-flight navigation. |
| **render/** | Rendering pipeline setup (WebGL2/WebGPU), post-process effects, and global render configuration. |
| **io/** | Texture and asset management, asynchronous loading, and I/O helpers for data and worker communication. |
| *(optional)* **math/** | Extra math utilities extending Babylon.js (vector ops, matrix transforms, precision helpers). |
| *(optional)* **workers/** | Generic worker interfaces and thread communication patterns for parallel computation. |

## ⚙️ Design Principles

- **Isolation:**  
  No file inside `core/` should reference or depend on any higher-level directory (e.g., `systems/`, `game_objects/`, `game_world/`).

- **Reusability:**  
  Every module can be reused across different projects or simulations without modification.

- **Determinism & Purity:**  
  Core functions should be deterministic and side-effect-free whenever possible.

- **Composition over inheritance:**  
  Keep systems modular and composable rather than building deep class hierarchies.

- **Statelessness:**  
  Avoid global state; rely on dependency injection or explicit configuration objects.

## 🔗 Relationships

```
core/  →  systems/  →  game_objects/  →  game_world/  →  screens/
```

- `core/` provides low-level functionality.
- `systems/` builds reusable gameplay or engine systems using `core/`.
- `game_objects/` defines domain-specific entities (e.g., rocky planets).
- `game_world/` assembles those entities into an interactive simulation.
