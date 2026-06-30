---
name: project-cdlod-abandoned
description: CDLOD terrain path is abandoned; OCBT is the sole rendering path going forward
metadata: 
  node_type: memory
  type: project
---

CDLOD is abandoned — OCBT (pool-CBT GPU path) is the only terrain rendering path going forward.

**Why:** User confirmed 2026-06-26. CDLOD was the legacy path; OCBT is the modern GPU-driven path with per-pixel analytic normals, Lommel-Seeliger BRDF, df64 precision, and indirect draw.

**How to apply:** 
- Ignore all CDLOD-specific code (terrainVertexShader.glsl, terrainFragmentShader.glsl, ChunkTree CDLOD path, StandardMaterial terrain) in analysis and recommendations.
- All lighting, shadow, and shading work should target OCBT shaders (`src/assets/shaders/terrain/`, `src/systems/lod/terrain/`).
- Do not suggest maintaining parity between CDLOD and OCBT.
- See [[ocbt-integration]] for OCBT architecture details.
