---
name: gpu-device-hang-dense-topology
description: Unresolved DXGI_ERROR_DEVICE_HUNG crash near dense ground-level OCBT topology; not caused by Apply/rebuildTerrain, root cause still unknown
metadata:
  type: project
---

Reproducible WebGPU driver crash (`ID3D12Device::GetDeviceRemovedReason` → `DXGI_ERROR_DEVICE_HUNG`
→ `BJS - WebGPU context lost` → page frozen white, no visible error to the user) when the camera
sits at close/mid range above the Dev Moon with the OCBT topology densely converged (~100k leaves).
Confirmed via Playwright, 2026-07-01.

**What it is NOT:**
- Not caused by oversized textures (reproduced identically before and after the 4096→1024 resize).
- Not caused by `rebuildTerrain()`'s dispose+recreate (the options-menu "Apply" hot-rebuild path) —
  fixed that path anyway (see below) but the crash still reproduces with NO Apply click at all.
- Not caused by opening the Tweakpane options menu specifically, though that action correlated with
  a repro once — a control run (teleport + 5s idle, no menu) did NOT crash, but a shorter idle + menu
  toggle did. Timing is inconsistent enough that menu-open is probably a red herring, not the trigger.

**What's confirmed to correlate:** dwelling at close/mid altitude (2km-10m tested) above a
planet whose OCBT topology is deeply converged (~100k+ live leaves) for some accumulated
time/frame count. Reproduced via `__world42Perf.setCameraDoublePos`/`lookAtDoublePos` instant
teleport (bypassing the gradual convergence a real flight-down would produce), which may itself be
a contributing factor (forces near-max subdivision demand in very few frames) rather than the true
root cause.

**Fix shipped (real, but partial):** `TerrainPlanet.rebuildTerrain()` in
[terrain_scheduler.ts](../../src/systems/lod/terrain/terrain_scheduler.ts) used to `old.dispose()`
then `getOrCreateSource()` (~15 GPU storage buffers + compute pipelines destroyed and recreated) in
one synchronous tick — now the recreate is deferred to `scene.onAfterRenderObservable.addOnce(...)`,
spreading the GPU churn across a frame boundary. This is a legitimate risk reduction for that one
code path but does NOT close out the bug — the crash still reproduces without ever touching Apply.

**Root-cause work, session 2 (2026-07-01, same day):** confirmed via Windows Event Log
(`Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='nvlddmkm'}`, event ID 153) that
these are REAL D3D12/TDR driver hangs, not a Playwright/Chromium artifact — and that this GPU
(RTX 5080, driver 596.49 at the time) has been hitting TDR sporadically for months (Jan-Jun 2026),
correlated with OCBT dev/testing sessions, not something newly introduced this session.

Found and instrumented the likely mechanism: `TerrainSource` arms a ~90-frame "convergence burst"
(`SETTLE_FRAMES`) after any discrete camera jump (`terrain_source.ts`, `convergeFrames`), during
which the FULL topology pipeline (classify/split/merge/eval/compact over the whole pool — commented
as ~7-31 ms/frame depending on pool size) is force-rebaked on EVERY consecutive frame with zero
gap — up to ~90 back-to-back heavy GPU submissions. Added `BURST_REBAKE_STRIDE` (default 2,
`globalThis.__terrainBurstStride` live-tunable) to skip every Nth frame during the burst, spreading
the same total convergence work over more wall-clock frames instead of submitting it back-to-back.
Also fixed `TerrainPlanet.rebuildTerrain()` (`terrain_scheduler.ts`) to defer the new source's
creation to `scene.onAfterRenderObservable.addOnce(...)` instead of dispose+recreate in one
synchronous tick.

**Verdict: INCONCLUSIVE, not a confirmed fix.** Both changes are real, defensible improvements
(kept), but repeated A/B testing after shipping them still reproduced the crash intermittently (1
crash in 5 realistic repro attempts post-fix, vs. crashing on most/all attempts pre-fix — suggestive
of reduced frequency, but the sample size is too small and the bug too intermittent to call it
solved). A separate synthetic torture test (a tight `requestAnimationFrame` polling loop sampling
`getStats()` every frame for 150 frames via Playwright `evaluate`) crashed with a suspiciously
CONSTANT ~11.5 s stall-then-crash signature regardless of the stride value (2 or 4) — this constant
timing independent of the code change suggests that specific torture test may be hitting a different,
tooling/environment-level timeout (CDP bridge overhead, virtual-display GPU watchdog) rather than
the app's own compute load. Do not read too much into that specific test.

**Mitigating factor worth remembering:** the 90-frame burst is only armed by a discrete JUMP
(`jump > JUMP_FACTOR * driftThreshKm` — a large, sudden camera displacement). Normal gradual
player-driven flight (WASD-equivalent controls, frame-by-frame movement) essentially never triggers
it; only instant programmatic teleports (`__world42Perf.setCameraDoublePos`, the debug `T` key) or
very-high-speed boost flight arriving at ground level in very few frames would. So the crash
conditions reproduced here are somewhat of an edge case, not necessarily hit during ordinary play.

**Not yet done:** true root-cause is still open. Untested suspects: (1) the `forcedInstanceCount`
jump to full pool `capacity` before the first live-count readback resolves (terrain_source.ts, in
the constructor's `whenReady().then()`), (2) whether the torture-test's ~11.5s constant-timing crash
is actually a Playwright/CDP-environment artifact unrelated to World42 code, (3) whether a GPU
driver update (this machine was on a very new RTX 5080 driver, 596.49, at time of investigation)
changes anything. See [tile-cache-view-dependence](tile-cache-view-dependence.md) for the unrelated,
already-abandoned tile-cache work — do not conflate the two.

**How to apply:** if the user reports a WebGPU crash / frozen white screen during ground-level play,
this is the known suspect — but ask whether it happened after an abrupt viewpoint change
(teleport/high-speed arrival) since gradual flight is much less likely to trigger the burst at all.
Don't claim this is fixed; the two shipped changes are risk-reducing, not a confirmed resolution.
