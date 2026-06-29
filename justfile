# World42 task runner — a thin, ergonomic façade over the npm scripts in package.json.
# The npm scripts remain the source of truth (CI, `npm ci`, etc.); this file just adds
# descriptions, argument passthrough and a readable `just --list`.
#
# On Windows, recipes run through PowerShell (matches the project's primary shell and the
# gpu_hud_bridge.ps1 it launches); elsewhere `just` falls back to sh.
#
#   just            # list all recipes
#   just dev        # dev server
#   just probe --scenario ground-drift --knob rebakeEvery=1,3,6

set windows-shell := ["powershell.exe", "-NoProfile", "-Command"]

# Show all available recipes (default).
default:
    @just --list

# --- Dev / build / deploy --------------------------------------------------------------

# Dev server -> http://localhost:19000
dev:
    npm run serve

# Production build -> /dist
build:
    npm run build

# Deploy /dist to GitHub Pages (requires a prior `just build`).
deploy:
    npm run deploy

# --- Tests -----------------------------------------------------------------------------

# Vitest in watch mode.
test:
    npm test

# Vitest once, with coverage report (-> /coverage/index.html).
coverage:
    npm run coverage

# Microbenchmarks (vitest bench, single run).
bench:
    npm run bench

# --- Perf / profiling ------------------------------------------------------------------

# GPU HUD bridge (nvidia-smi -> public/gpu_stats.json). Run BEFORE dev/perf or the HUD
# GPU% line reads "n/a". Wraps scripts/gpu_hud_bridge.ps1 via npm.
[doc("GPU HUD bridge (nvidia-smi -> public/gpu_stats.json); run before dev/perf")]
hud:
    npm run gpu:hud

# Example: just probe --scenario ground-drift --knob rebakeEvery=1,3,6
[doc("Perf probe knob sweep (headed Playwright + nvidia-smi); pass-through flags")]
probe *args:
    node ./scripts/perf_probe.mjs {{args}}

# Example: just bench-flight --label before  /  --label after --baseline before
[doc("Deterministic ground->orbit flight bench (before/after diff)")]
bench-flight *args:
    node ./scripts/bench_flight.mjs {{args}}

# Deterministic headless perf capture (single config).
perf-capture:
    npm run perf:capture

# Perf capture matrix sweep.
perf-matrix:
    npm run perf:matrix

# Grain / normal-AA probe.
grain:
    npm run grain

# --- Playwright ------------------------------------------------------------------------

# Playwright CLI passthrough, e.g. `just pw list`, `just pw snapshot`, `just pw screenshot`.
pw *args:
    node ./scripts/playwright_cli.mjs {{args}}

# World42 smoke / validation run.
pw-validate:
    npm run pw:validate
