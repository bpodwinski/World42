---
name: dev-gpu-hud-bridge
description: "For World42 dev/perf: always start the GPU HUD bridge (scripts/gpu_hud_bridge.ps1 / npm run gpu:hud) before serving — the in-app GPU% line is dead without it"
metadata: 
  node_type: memory
  type: feedback
---

For World42 development the user wants the GPU HUD bridge **always launched first**, alongside the dev
server. Command: `npm run gpu:hud` (= `powershell -ExecutionPolicy Bypass -File scripts/gpu_hud_bridge.ps1`),
in its own terminal / minimized window. It loops `nvidia-smi` every 500 ms into `public/gpu_stats.json`,
which the dev server serves; the HUD (press **P**) polls it once a second.

**Why:** the browser can't read OS-level GPU stats, so without the bridge the HUD's whole-device line
shows `GPU% n/a` — the user noticed this every dev session and called it out twice. Requires `nvidia-smi`
on PATH (NVIDIA driver).

**How to apply:** when starting a World42 dev/perf session (or when launching a browser/Playwright run to
eyeball the HUD), start the bridge first (or confirm `public/gpu_stats.json` is fresh). NOTE: this only
feeds the nvidia-smi line (`GPU % vram MHz W`). The in-engine WebGPU-timestamp lines — `gpu …ms (canvas)`
and the Phase 2 `ocbt topo/eval/compact ms` — work with just `P`, no bridge. For scripted GPU measurement
use the `world42-perf-probe` skill (`scripts/perf_probe.mjs`), which spawns nvidia-smi itself.
