# 🧠 Game Objects Module

The **`game_objects/`** directory contains *high-level engine systems* and *domain-specific implementations* built on top of the reusable modules in `core/` and `systems/`.  
This layer defines **what** is rendered and simulated — for example, planets, moons, or other celestial bodies — using the foundational logic provided by lower layers.

## 📁 Directory Overview

| Folder | Description |
|:-------|:-------------|
| **planet/** | Implementation of planetary objects using the quadsphere model. |
| **planet/rocky_planet/** | Specialized logic for rocky worlds — includes quadtree LOD, terrain chunk generation, and shaders. |
| **planet/rocky_planet/quadtree/** | CDLOD / quadtree subdivision algorithms for planetary surfaces. |
| **planet/rocky_planet/chunks/** | Geometry generation and GPU-ready mesh data per LOD node. |
| **planet/rocky_planet/terrain/** | Material and heightmap utilities for realistic terrain. |
| **planet/rocky_planet/shaders/** | GLSL/WGSL shader programs for surface rendering and displacement. |

## ⚙️ Design Principles

This layer bridges the gap between **engine-level systems** and **game-world entities**.  
It defines concrete, renderable objects that can be instantiated into the Babylon.js scene.

In short:  
> `core` and `systems` describe *how* things work.  
> `game_objects` defines *what* things exist.

## 🔗 Relationships

```
core/ → systems/ → game_objects/ → game_world/ → screens/
```

- Uses camera, control, scale, and rendering utilities from `core/`.
- Uses LOD, worker, and async scheduling from `systems/`.
- Exposes ready-to-render entities to `game_world/` (e.g. `PlanetEntity`).
