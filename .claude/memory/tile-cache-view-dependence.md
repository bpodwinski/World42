---
name: tile-cache-view-dependence
description: GPU atlas tile cache artifacts — root causes (normal Z encoding, df64, footprint) and the view-dependence limit
metadata:
  type: project
---

The OCBT GPU **atlas tile cache** (bake terrain normal+albedo per stable leaf into an
8192×8192 atlas, sampled in the fragment fast path) produced per-triangle "triangular
artifacts" near the ground with `window.__world42Perf.setPerfMask(0)`. Root causes found
and fixed (2026-06-30, CBT branch):

1. **Normal Z sign/magnitude lost.** The bake stored only `nLocal.xy` and the fragment
   reconstructed `z = sqrt(1-x²-y²)` (always ≥0). But `nLocal` is a **planet-local-space**
   normal pointing radially along `dir` — its Z spans [-1,1] across the quad-sphere, so the
   hemisphere assumption flipped/clamped it. Fix: store full XYZ (atlas is `rgba16float`,
   B channel was free), read `.xyz`. Files: `terrain_bake_tile.compute.wgsl`,
   `terrain_render_material.ts` fragment fast path.

2. **Missing df64 ground detail.** Below `GROUND_OFF_KM` (0.15 km; on 0.05) the live path
   adds df64 cm-relief. The bake works in f32 `dir` space (~17 cm precision at the Moon's
   1737 km radius) and **cannot** carry df64 detail → baked tiles are smooth facets among
   detailed live neighbours. Fix: gate the fast path on `dFade <= 0` (use the live path
   wherever df64 is active). The handoff is seamless because dFade→0 at the threshold.

3. **Footprint mismatch.** The live path Nyquist-fades fbm octaves by per-pixel `fpKm`; the
   bake used footprint 0 (full detail) → baked triangles grainier than faded neighbours.
   Fix: bake fbm at the tile's native texel footprint `maxEdge*radius/63`.

4. **Distance minification grain** ("moins au sol, encore au loin"). A 64×64 tile has **no
   mips**; the LOD keeps triangles small on screen, so distant triangles shrink below 64 px
   → the tile is minified and point-sampled → inter-tile aliasing. First fix was a
   minification gate (fall to live past 1 texel/px) — killed the grain but disabled the cache
   at distance (no perf there).

   **Now solved with a compact coarse-mip pyramid (implemented).** Babylon's
   `ComputeShader.setStorageTexture` binds whole-texture only (no mip-level arg), and the
   per-planet atlas is already ~800 MB, so hardware mips were rejected (raw-WebGPU + ~+380 MB).
   Instead: a second **coarse atlas** (1024², 8×8 per tile = ×8 downsample, ~12 MB/planet,
   nearest → zero bleed) written by a new `terrain_reduce_coarse.compute.wgsl` pass (1
   workgroup/tile over the bake worklist, runs right after the bake). The fragment blends
   mip0↔coarse by `lodT = clamp(log2(max(texPerPx,1))/3, 0, 1)` and the minif gate is **lifted**
   (cache now active at distance). Files: `terrain_engine_buffers.ts` (COARSE_* consts +
   preamble), `terrain_source.ts` (coarse atlases + reducePass + dispatch + dispose),
   `terrain_render_material.ts` (coarse bindings + LOD blend). Validated at 3 km horizon:
   0 WebGPU validation errors, atlas-vs-live 0.056% mean / 0.003% strong (≈ control floor
   0.042%), no seam ring.

5. **Magnification facets** ("on voit les triangles" at alt 0 km, perfMask 0). A 64×64 tile
   baked at its texel footprint UNDER-resolves when the screen pixel footprint is finer than
   the tile's (`texPerPx < 1`, magnified/close/large-triangle) → flatter than the live
   per-pixel noise → flat triangular facets. `texPerPx == fpKm/texelFpKm` exactly, so the gate
   is: take the fast path only when `tsc_texPerPx >= TERRAIN_TILE_MAG_GATE` (1.0); below that
   fall through to live (at texPerPx==1 the tile is 1:1, same footprint → seamless). NEW gate,
   distinct from the lifted minif gate (which was inverted — used the atlas where it
   under-resolves). Validated: horizon unchanged (0.058%); magnified region → live (no facets,
   live has continuous per-pixel normals).

   **Known residual (not facets):** in the INTERMEDIATE band (`texPerPx ~2–6`) at fine-footprint
   nadir views the 2-level pyramid over-smooths ≈4% (mip0 ×1 and coarse ×8 are 3 levels apart →
   linear blend imperfect; atlas softer than live, no facets/grain/seams). Tightening needs a
   fuller chain (×2 = 4096² ≈ 192 MB/planet, or ×4 = 2048² ≈ 48 MB) or a higher mag gate (more
   pixels → live, less perf). The cache's accurate band is narrow: matches live at the far
   horizon (pure coarse) and ~1:1; the middle is the weak spot. Open decision.

   GPU note: very low heavy nadir views (~50 m, grazing overdraw) TDR-hung the device under
   repeated freeze/capture stress in the virtual display; the reduce pass isn't the cause (313k-
   leaf horizon stays stable). Likely environmental.

**Fundamental limit:** a baked tile is **view-independent**; the terrain's fragment shading
has **view-dependent** terms (per-pixel footprint AA fade + df64 near-ground detail). A tile
can only match the live path in the view-independent regime (dFade==0, footprint≈texel). So
the cache helps at mid altitude but is gated off near the ground.

**Oversubscription:** atlas = 16,384 tiles; at ground level the Moon shows 300k–400k leaves
→ ~5% coverage (`terrainTilesUsed` pins at 16384). Even when faithful, the cache covers a
small fraction of visible triangles at low altitude. Killing the `O(capacity)` floor and
raising coverage is open work.

**Validation method:** freeze topology (`setFreezeTopology(true)` + `setAdaptiveRebake(false)`),
screenshot perfMask=0 (atlas) vs perfMask=256 (live), pixel-diff. Same-mode control floor
≈0.6% (TAA jitter). After the fixes, atlas-vs-live strong-diff pixels dropped 3.43%→0.89%.
Measure only with topology FROZEN — a converging LOD inflates the control to ~2.6%.

See [[ocbt-integration]] and [[playwright-cannot-measure-gpu-perf]].
