# ⚙️ Systems Module

The **`systems/`** directory contains *engine-level gameplay and simulation systems* that operate above the generic `core/` layer, but below the content-specific `game_objects/` layer.  
Each system in this directory provides reusable logic that can be applied to multiple types of entities (e.g., LOD management, async loading, worker scheduling, physics updates).

## 📁 Directory Overview

| Folder | Description |
|:-------|:-------------|
| **lod/** | Level of Detail (LOD) system for quadtree subdivision and CDLOD terrain streaming. |
| **lod/workers/** | Web Worker pool and communication layer for offloading geometry computations. |
| **lod/cache/** | Tile caching, eviction policies, and geometry reuse. |
| **lod/metrics/** | Error estimation, screen-space metrics, and hysteresis management. |
| **physics/** | Floating-origin transformations and movement updates (optional). |
| **scheduler/** | Frame budget scheduler for controlling async operations. |
| **...** | Future systems (AI, networking, etc.) can be added here. |

## ⚙️ Design Principles

`systems/` defines **how the engine behaves** — handling LOD, physics, async data flow, and rendering strategies.  
Unlike `game_objects/`, which defines *what* exists in the world, these modules define *how* those things update and interact.

## 🔗 Relationships

```
core/ → systems/ → game_objects/ → game_world/ → screens/
```

- Builds upon foundational modules in `core/` (camera, scale, workers, etc.).  
- Provides services to `game_objects/` (planet LOD, physics updates, etc.).  
- Contains no hard-coded planet or mesh references — systems are generic and reusable.
