# How to map this paper into World42

World42 already uses:
- quadtree/CDLOD patches
- web workers (CPU async geometry)
- floating origin (Render-space)
- planet-local meshes

This paper provides a different approach:
- keep triangulation **GPU-resident**
- drive refinement/decimation in compute shaders (or GPU compute path)
- represent topology via halfedges + bisectors, not quad patches

## Integration options

### Option A — Reference-only (short term)
Use the paper as theoretical backing for:
- screen-space triangle area LOD metric
- incremental updates rather than full rebuilds
- memory sizing and precision guidance

### Option B — Hybrid (medium term)
Keep your CPU quadtree, but:
- move refinement decision + crack-conforming triangulation to GPU
- use a CBT-like pool to manage patch instances (not necessarily bisectors)

### Option C — Full GPU triangulation (long term)
Adopt bisectors + halfedge input mesh:
- base mesh could be a dodecahedron/icosahedron for a planet
- run 9-kernel loop each frame (or amortized)
- output triangles into an index/vertex stream (or visibility buffer-like ID buffer)

## World42 coordinate-space rule
All computations used for:
- LOD metric (screen error / area)
- neighbor tests
- horizon culling (if added)
must use consistent space.

Recommended:
- compute metric in WorldDouble on CPU (high precision), then feed per-bisector thresholds
- OR compute entirely in Render-space with floating origin and stable local coordinates

## Rendering output
The paper uses a visibility buffer approach after triangulation.
In Babylon.js/WebGL2, you can:
- generate a triangle list (positions + indices) into SSBO-like buffers (WebGPU easier)
- or compute indirect draw arguments if the platform supports it
- else, treat as research reference until WebGPU path is in place

## What to steal immediately
- “CBT as allocator + iterator” pattern
- safe decimation rules (conservative merges)
- explicit GPU kernel pipeline design (reset → cache pointers → commands → reserve → fill → update pointers → bitfield → reduce)
