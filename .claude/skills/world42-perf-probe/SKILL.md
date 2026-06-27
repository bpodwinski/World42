---
name: world42-perf-probe
description: Profile and diagnose World42 GPU/CPU performance with a headed Playwright harness plus nvidia-smi and OS counters. Use when a request mentions GPU at 100%, perf profiling, frame drops/hitches, gpuMs, GPU/CPU utilization, terrain/OCBT cost, fragment-vs-compute bottleneck, or "why is it slow at ground/orbit". Covers scripts/perf_probe.mjs, the window.__world42Perf debug API, and the webgpu-inspector MCP for structural captures.
---

# World42 Perf Probe

How to measure World42 rendering performance correctly. The naive approach (read the in-app HUD
`gpuMs`, or run Playwright headless) gives **garbage** — this skill explains why and gives a
working harness.

## TL;DR

```bash
npm run serve                 # dev server must be running (port 19000)
node scripts/perf_probe.mjs --scenario ground-drift --knob rebakeEvery=1,3,6
```
Reads a clean table: GPU util (med/p90/max), VRAM, power, clock, CPU-app%, CPU-renderer%, fps,
leaves, draws — one row per knob value.

## Why the obvious methods fail (read this first)

- **Headless throttles** `requestAnimationFrame` to exactly 30 fps and exposes **no WebGPU
  timestamp queries**, so `engine.getFps()` and `gpuMs` are meaningless. → Always run **headed**.
- **In-app `gpuMs` is broken on this machine** (WebGPU timestamp queries unavailable → reads
  ~0.008 ms, non-monotonic). The rule of thumb `gpuMs < 0.1 ⇒ broken` holds here. → Measure load
  from **outside** the browser (nvidia-smi + OS CPU counters), not from `getStats().gpuMs`.
- **vsync caps fps at 60.** At normal resolution everything sits at 60 fps with headroom, so fps
  deltas are invisible. → Read **GPU/CPU utilization** (headroom), or **saturate** the GPU with
  `--knob hwScale=0.5` (supersample) until fps drops below 60.
- **Polling `getStats()` every frame perturbs the result** — it can force GPU readbacks and
  manufacture fake stalls (observed: fake "fps=5" that vanished once polling stopped). → The
  harness samples nvidia-smi/CPU on a **separate cadence** and reads `getStats()` only sparsely.
- **Still ≠ moving.** The OCBT re-bake gate makes the topology compute ~0 when the camera is
  still; the cost only appears under camera motion (drift). Always profile the regime that
  matches the complaint (still vs drift vs fly).
- **TDR / device-hung** happens past ~0.6 supersampling combined with continuous re-bake. Keep a
  margin; if `DXGI_ERROR_DEVICE_HUNG` appears, lower `--hwScale`.

## The harness — `scripts/perf_probe.mjs`

Headed Chromium (Playwright) driven through the `window.__world42Perf` debug API. Per knob value
it parks the camera in a scenario, settles, then samples four metric families.

### Flags
| Flag | Default | Meaning |
|------|---------|---------|
| `--url` | `…/?system=Dev&planet=Moon` | app URL |
| `--planet <i>` | 0 | index into `getPlanets()` |
| `--scenario <name>` | `ground-drift` | camera regime (below) |
| `--knob <name=v1,v2,..>` | none | sweep one knob |
| `--window <sec>` | 5 | sampling window per value |
| `--hwScale <f>` | 1 | base render scale (`<1` supersamples to saturate) |
| `--headless` | off | only for structural/console checks, NOT perf |
| `--keep` | off | leave the browser open at the end |

### Scenarios (camera regime)
| Name | Altitude | Drift | Use for |
|------|----------|-------|---------|
| `ground-still` | 60 m | none | isolate the fragment/shading cost (re-bake gated off) |
| `ground-drift` | 60 m | slow | the real piloting cost (re-bake active) — the usual "100% at ground" case |
| `ground-fly` | 60 m | fast | fast-motion regime (often LIGHTER — terrain recedes, fewer leaves) |
| `low-orbit` | R·0.5 | none | mid-altitude |
| `orbit` | R·3 | none | distant body |

Drift uses `nudgeCameraDoublePos` (no LOD reset) so the OCBT drift gate / re-bake throttle
engages exactly like keyboard piloting — unlike `setCameraDoublePos`, which teleports (forces a
convergence burst).

### Knobs (perf levers, all live-tunable)
| Knob | Global | What it isolates |
|------|--------|------------------|
| `perfMask` | `__ocbtPerfMask` | fragment blocks: bit0 slope normal, bit1 **df64 ground detail**, bit2 crater rays, bit3 AO, bit4 GGX spec (31 = skip all shading) |
| `rebakeEvery` | `__ocbtRebakeEvery` | OCBT re-bake throttle (1 = every frame/old, 3 = default, higher = cheaper motion) |
| `df64NearKm` | `__ocbtDf64NearKm` | eval df64→f32 cutoff distance (the per-vertex noise precision band) |
| `hwScale` | `setHardwareScaling` | render resolution (fragment load); `<1` supersamples |

## Metrics (what each column means)

- **GPU% (med/p90/max)** — whole-GPU utilization from `nvidia-smi` over the window. p90/max expose
  spikes (a re-bake frame pinning 100%). This is the headline "is the GPU saturated" number.
- **VRAM / Pwr / Clk** — `memory.used` MB, `power.draw` W, graphics clock MHz (nvidia-smi). Power
  is a good proxy for real GPU work even when util is vsync-limited.
- **CPUapp%** — summed CPU-seconds of the Playwright Chromium processes (`Get-Process`, path-
  filtered to `ms-playwright`) ÷ (wall × logical cores). The app's whole CPU footprint.
- **CPUrndr%** — renderer main-thread busy fraction via CDP `Performance.getMetrics` `TaskDuration`.
  A **high CPUrndr% with low GPU%** means a CPU/sync stall (e.g. a per-frame GPU readback), not a
  GPU-compute bottleneck — different fix entirely.
- **leaves / draws** — `getStats().cbt.leafCount` and `drawCalls` (cheap structure, sampled once).

## Diagnosing a bottleneck (decision tree)

1. `--scenario ground-still --knob hwScale=1,0.7,0.5`. If GPU% stays low and fps stays 60 even at
   0.5 (heavy supersample) → **the fragment/shading is NOT the bottleneck**.
2. `--scenario ground-drift --knob rebakeEvery=1,3,6`. If GPU%/power drop sharply as N rises →
   the cost is the **per-frame OCBT re-bake** (topology + eval + compact), not the fragment.
3. `--scenario ground-drift --knob df64NearKm=0.05,2,20`. If GPU% is flat → the **eval df64 noise
   is NOT the cost** (so `eval`-side optimizations won't help that regime).
4. `--scenario ground-still --knob perfMask=0,2,31` (saturate with `--hwScale 0.5`). If `mask=2`
   (skip df64 ground detail) or `mask=31` drops GPU% a lot → **fragment-shader-bound**; otherwise
   it's raster/MSAA or compute.
5. Watch **CPUrndr%**: if it's high while GPU% is moderate, chase a CPU/sync stall (readbacks).

Established baseline (RTX 5080, Dev/Moon) — note the **resolution dependence**, it bit an earlier
analysis:
- At **low effective resolution / low leaf count**, even ground-still is GPU-light (60 fps with
  headroom), and the moving cost is dominated by the per-frame OCBT **re-bake** (`rebakeEvery=1`
  pins 100% spikes; `=3` removes them).
- At **high resolution + high leaf count** (e.g. `hwScale 0.5`, ~750k leaves), ground-**still**
  alone saturates the GPU and the **fragment shading is a major cost**: `perfMask=2` (skip the
  df64 ground detail, bit1) took GPU 100%→78%, `perfMask=31` (skip all shading) 100%→41%. So the
  df64 per-pixel ground normal ≈ a fifth of the GPU at that resolution.

Lesson: **always profile at the user's real resolution** (or saturate with `--hwScale`) before
concluding "the fragment is cheap" — that verdict is resolution-dependent. The full ground picture
is fragment-df64 (still, res-bound) **plus** re-bake compute (motion); they need different fixes.

## Structural profiling — webgpu-inspector MCP

The harness measures *timing/load*; for *structure* (pass counts, dispatch workgroup sizes, draw
instance counts, validation errors) use the **webgpu-inspector** plugin (separate headful Chrome):

- `/webgpu-inspector:capture url=http://localhost:19000/?system=Dev&planet=Moon` → summary
  (draws, dispatches, render/compute passes, validation errors).
- Then `get_commands` (filter by method, e.g. `dispatchWorkgroups`, `drawIndexed`) and
  `get_draw_state <index>` to see which buffer/pipeline a draw used (e.g. which planet's terrain,
  the live instance count). This is how the "off-screen planet still drawing 944k leaves" and the
  "eval dispatches over the full 1M pool" findings were made.
- webgpu-inspector gives NO timing — pair it with this harness for the load numbers.

## The `window.__world42Perf` debug API (setup_runtime.ts)

| Method | Use |
|--------|-----|
| `enableCapture(on)` | arm the in-app instrumentation counters (call once) |
| `getStats()` | `{ fps, frameMs, gpuMs(broken), drawCalls, osGpu, cbt:{leafCount,…} }` |
| `getPlanets()` | `[{ key, center:[x,y,z], radiusSim }]` |
| `setCameraDoublePos(x,y,z)` | **teleport** (calls `resetNow` → convergence burst) |
| `nudgeCameraDoublePos(dx,dy,dz)` | **drift** without a LOD reset (real piloting; engages the re-bake gate) |
| `lookAtDoublePos(x,y,z)` | aim at a WorldDouble point |
| `setHardwareScaling(level)` | engine render scale (`<1` supersamples — saturate the GPU) |
| `setPerfMask(mask)` | fragment perf-mask (or set `window.__ocbtPerfMask`) |

`nudgeCameraDoublePos` and `setHardwareScaling` exist specifically for this harness; keep them.

## Prerequisites & gotchas

- Dev server running (`npm run serve`, port 19000).
- `nvidia-smi` on PATH (NVIDIA GPU). On other GPUs, replace the `gpuSample()` source.
- Windows PowerShell for `CPUapp%` (`Get-Process … Measure-Object CPU`). Close other Chrome
  windows for a clean CPU-app number, or rely on the `ms-playwright` path filter.
- Confirm the build is fresh after a `.ts` edit: `curl -s localhost:19000/index.js | grep -c <marker>`
  before trusting a result (a stale bundle has caused false readings before).
