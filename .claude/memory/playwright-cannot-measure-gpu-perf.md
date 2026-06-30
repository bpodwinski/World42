---
name: playwright-cannot-measure-gpu-perf
description: Playwright/headless Chrome cannot measure World42 GPU render perf — rAF throttled to 32fps + virtual display cap; use the world42-perf-probe skill or a real browser
metadata: 
  node_type: memory
  type: feedback
---

**USE THE SKILL: `world42-perf-probe`** (`scripts/perf_probe.mjs`) — a HEADED Playwright harness that measures GPU/CPU load correctly (nvidia-smi GPU util/mem/power/clocks + CPU via Get-Process + CDP Performance.getMetrics). `node scripts/perf_probe.mjs --scenario ground-drift --knob rebakeEvery=1,3,6`. Scenarios: ground-still/ground-drift/ground-fly/low-orbit/orbit.

**DETERMINISTIC FLIGHT BENCH:** `npm run bench:flight -- --label before` then `--label after --baseline before` (`scripts/bench_flight.mjs` + in-page `window.__world42Bench.run({frames,planet,groundFrac})`). Replays a FIXED ground→orbit+yaw path FRAME-INDEXED (1 pose/rendered frame, planet spin FROZEN), so the trajectory is identical every run → apples-to-apples before/after diff. Per-phase medians of nvidia-smi power + OCBT GPU buckets. Leaf counts match <1% between runs; power/leaves ±1% solid, per-bucket ms ~5-10% noisy (use medians, ≥300 frames).

**The per-ComputeShader `gpuTimeInFrame` counters ARE reliable under Playwright** — that's only `gpuTimeInFrameForMainPass` (canvas gpuMs) that reads ~0. The Phase-2 OCBT buckets (topo/eval/compact ms) read real values in Playwright.

**PROFILING FINDINGS (Dev/Moon):** STILL ground = FRAGMENT-bound, slope normal (perfMask bit0) ~21W + crater rays (bit2) ~10W dominate. MOVING ground (flight bench) = COMPUTE kicks in: topology ~3.5ms + eval ~1.8ms avg at ~195k leaves (O(1M-pool) classify/copy/reduce). Fragment cost is RESOLUTION-DEPENDENT: at low res fragment is cheap; at high res+high leaf count (hwScale 0.5, ~750k leaves) ground-still saturates GPU — df64 ground detail alone ~22% GPU.

**Playwright virtual display cap (32Hz):** even in headed mode the RAF is capped at 31.25ms — FPS measurements are meaningless. Watt/GPU% measurements require a real browser opened by the user with `npm run gpu:hud`.

**GRAIN PROBE:** `npm run grain` (`scripts/grain_probe.mjs`) — objectively measures grazing-sun normal aliasing: poses a deterministic raking-light nadir view (sun 5°), FREEZES topology, compares native vs 16×-SSAA (hwScale 0.25). Metric = luminance RMSE + Laplacian HF energy. KEY FINDING: grazing-SUN grain is intrinsic to per-pixel normal sampling under NdL amplification; NO static shading param fixes it cleanly — the clean fixes are TEMPORAL (TAA) or mean-preserving normal AA.

Instrumentation counters (`frameMs`, `cbt.classifyMs`, `cbt.rebuildMs`, gpuMs) are DORMANT until you call `__world42Perf.enableCapture(true)` first — without it they read 0.
