---
name: frame-graph-integration
description: "World42 render pipeline on Babylon 9 Frame Graph — Phase 1 (render+post) + Phase 2 (OCBT compute task + per-pass GPU profiling) done; MSAA dropped to single-sample; design, gotchas, status"
metadata: 
  node_type: memory
  type: project
---

World42's render/post pipeline runs on the **Babylon 9 Frame Graph (v1)**. Phase 1 (render+post) done 2026-06-26; Phase 2 (OCBT compute IN the graph) done 2026-06-28. Builds on [[babylon9-migration]]. See [[ocbt-integration]] for the OCBT compute itself.

**Task order (HDR until tonemap):**
`Clear → FrameGraphOcbtComputeTask → FrameGraphObjectRendererTask (terrain+skybox) → Star → TAA 16x → Bloom → ACES tonemap → FXAA → Sharpen → GUI → CopyToBackbuffer`

**KEY ARCHITECTURE FACTS:**
- `scene.frameGraph = fg` is the hookup. `scene.render()` fires `onBeforeRenderObservable`, evaluates active meshes inline, then `frameGraph.execute()` — the normal multi-camera render is SKIPPED.
- **GOTCHA:** `_renderWithFrameGraph` does NOT call `_evaluateActiveMeshes()`, so `onBeforeActiveMeshesEvaluationObservable` NEVER fires under a frame graph. `OriginCamera`'s floating-origin re-centering is registered there. FIX: in `setup_runtime.ts`, an `onBeforeRenderObservable` observer re-fires it: `scene.onBeforeActiveMeshesEvaluationObservable.notifyObservers(scene)`.
- OCBT compute task (`ocbt_compute_task.ts`) is a single wrapper `FrameGraphTask` inserted before `sceneRender`. Its `record()` adds a pass whose execute func calls `ctx.pushDebugGroup; runCompute(); ctx.popDebugGroup()`. Compute and render passes go into the SAME `_renderEncoder`, submitted once → GPU ordering guaranteed by insertion order.
- `graphOwnsCompute` flag: until `attachFrameGraph().then()` fires `onGraphReady`, the observer drives compute (startup transient); after, only the task does (no double-tick).

**MSAA DROPPED to single-sample (MSAA_SAMPLES = 1):** WebGPU can't resolve a DEPTH attachment via render-pass resolveTarget → 7 validation errors/frame + broken star occlusion. Single-sample depth is sampled directly by the star task. Geometric AA = TAA 16x (always-on, `disableOnCameraMove=true`) + FXAA.

**GUI fix:** the frame graph bypasses the scene layer pass → GUI vanished. FIX: `FrameGraphGUITask` with ADT created via `AdvancedDynamicTexture.CreateFullscreenUI("World42UI", true, { useStandalone: true, scene })`.

**Per-pass GPU profiling:** each kernel `ComputeShader.gpuTimeInFrame?.counter.lastSecAverage` (ms) → `OcbtTopologyKernel.getGpuTimings()` buckets topology/evalLeb/compact → HUD line (`ocbt topo/eval/compact`). The per-ComputeShader timestamps ARE reliable under Playwright (canvas gpuMs is not).

**ENV NOTE:** repeated automated Playwright WebGPU sessions can crash the GPU device (`DXGI_ERROR_DEVICE_REMOVED` / TDR) → "Timeout waiting for first task: sceneRender". A fresh page reload recovers — it is environmental, not a code bug.

**Files:** `src/core/render/frame_graph.ts`, `src/core/render/ocbt_compute_task.ts`. Runtime-unused fallbacks: `postprocess_manager.ts`, `taa_postprocess.ts`.
