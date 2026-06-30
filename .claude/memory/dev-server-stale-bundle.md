---
name: dev-server-stale-bundle
description: World42 Rspack dev server can serve a stale bundle after a .ts edit — verify before visual testing
metadata: 
  node_type: memory
  type: feedback
---

When debugging World42 in the browser (dev server on :19000), a `.ts`/shader edit may NOT reach the running page — the served bundle can be stale (HMR doesn't apply, or the page holds an old build). This caused a fix to be visually rejected ("c'est pas ça") TWICE when the fix was actually correct.

**Why:** a false-negative visual test wastes a whole investigation cycle and erodes trust in a correct fix.

**How to apply:** before concluding a visual test, confirm the edit is in the live bundle — add a unique marker token in the changed line and `curl -s http://localhost:19000/index.js | grep -c MARKER` (expect ≥1), then hard-reload (`browser_navigate` to the URL, not just reload). Only then screenshot. Related: [[ocbt-integration]].

**Root cause (confirmed):** `rspack.config.js` sets `liveReload: false` with HMR `hot`. So the dev server NEVER auto-full-reloads — it hot-swaps modules in place. But the OCBT/CBT `ShaderMaterial` bakes its WGSL (and the `DEFAULT_NOISE` constants) ONCE at scene creation, so a hot-swap does NOT rebuild the live material → shader/noise edits are invisible in the running tab until a MANUAL full page reload (Ctrl-Shift-R). When the user reports a shader/noise edit "does nothing", first tell them to hard-reload (or, for Playwright, always `browser_navigate` = full load). `?cbt=ocbt` teleports via `__world42Perf.setCameraDoublePos`; use `?bench=cbt-ocbt` to teleport reliably.
