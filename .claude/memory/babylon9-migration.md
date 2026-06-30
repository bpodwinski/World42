---
name: babylon9-migration
description: World42 migrated from BabylonJS 8.51 to 9.14 — what broke and the @webgpu/types gotcha
metadata: 
  node_type: memory
  type: project
---

World42 was migrated from BabylonJS **8.51.1 → 9.14.0** (all 6 `@babylonjs/*` packages) on 2026-06-26.

**The migration was nearly a no-op.** Only ONE Babylon API break surfaced under `tsc`: the global WebGPU type `GPUFeatureName` (used in `src/core/render/engine_manager.ts` `deviceDescriptor.requiredFeatures`) became undefined.

**Why / the gotcha:** Babylon 8 pulled `@webgpu/types` in transitively, so its ambient WebGPU globals were available for free. **Babylon 9 no longer depends on it.** Fix: `npm i -D @webgpu/types@^0.1.71` + a new `types/webgpu.d.ts` containing `/// <reference types="@webgpu/types" />`.

**Verification:** 150 vitest tests pass (1 skipped) on 9.14. tsc clean. The custom WGSL `ShaderMaterial` + storage-buffer OCBT path, WebGPU engine, PostProcess, `gpuTimeInFrameForMainPass`, `enableGPUTimingMeasurements`, instrumentation, `TAARenderingPipeline` — all still compile on 9.x with no signature changes.

Babylon 9 headline features relevant to World42 (not yet adopted): **Large World Rendering** (native floating-origin-style support), **Frame Graph** (declarative render-pass graph — adopted, see [[frame-graph-integration]]), **Physically Based Atmosphere**, **Inspector v2**.
