# World42 — AI Memory Index

This directory is the **canonical** memory store for AI agents working on this project.
It travels with the repo (committed, exportable).

> When writing a new memory: create a `.md` file here **and** add a one-line entry below.
> Also mirror to the system-level memory path (`~/.claude/projects/d--Dev-World42/memory/`) for auto-loading.

## Index

- [Language rule](feedback-language-english.md) — American English everywhere in source code, comments, identifiers, CLAUDE.md — no French in codebase
- [Playwright headed rule](feedback-playwright-headed.md) — ALWAYS use headed mode, never headless; applies to all Playwright MCP tool calls in this project
- [OCBT integration](ocbt-integration.md) — full running changelog of the OCBT pool-CBT terrain rewrite (Phases 1–4, GPU tile cache, profiling, lighting, rendering)
- [Measure GPU/CPU perf → world42-perf-probe skill](playwright-cannot-measure-gpu-perf.md) — use the `world42-perf-probe` skill; Playwright virtual display caps RAF at 32Hz; watt measurements need a real browser + `npm run gpu:hud`
- [Dev server stale bundle](dev-server-stale-bundle.md) — verify a .ts edit reached :19000 (curl+grep marker) before trusting a visual test; stale bundle caused 2 false "not it"
- [GPU HUD bridge](dev-gpu-hud-bridge.md) — ALWAYS start `npm run gpu:hud` before dev/perf; without it the HUD GPU% line is "n/a"
- [CDLOD abandoned](project-cdlod-abandoned.md) — CDLOD is dropped; OCBT is the sole terrain path going forward (confirmed 2026-06-26)
- [Babylon 9 migration](babylon9-migration.md) — on BabylonJS 9.14 (from 8.51); only break was GPUFeatureName → needs @webgpu/types dep + types/webgpu.d.ts
- [Frame Graph integration](frame-graph-integration.md) — render+post pipeline is a Babylon 9 Frame Graph; OCBT compute as a graph task; MSAA dropped to single-sample; per-pass GPU profiling
- [Atmosphere integration](atmosphere-integration.md) — custom single-scattering atmosphere as a Frame Graph task; frame-graph depth NOT sampleable → analytic sphere; star occlusion TODO
- [GPU device-hang near dense topology](gpu-device-hang-dense-topology.md) — UNRESOLVED DXGI_ERROR_DEVICE_HUNG crash at close-range dense OCBT topology; not caused by Apply/rebuildTerrain (ruled out); root cause still open
- [Spawn ignored default system (FIXED)](bug-spawn-ignored-default-system.md) — spawn hardcoded Sol/Mercury, ignoring data.json's "default"; Mercury has no profile so options-menu Apply silently did nothing (no error). Fixed 2026-07-01
