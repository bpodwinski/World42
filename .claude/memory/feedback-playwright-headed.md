---
name: feedback-playwright-headed
description: Always use Playwright in headed mode — never headless — for any browser test in this project
metadata: 
  node_type: memory
  type: feedback
---

Always launch Playwright in **headed** mode. Never use headless.

**Why:** The Playwright MCP tools (`browser_navigate`, etc.) can launch headed or headless. Headed was explicitly requested by the user after catching headless launches. Additionally, WebGPU performance measurements are meaningless headless (GPU throttled to ~1fps).

**How to apply:** When using any Playwright MCP tool, ensure headed mode is active. The MCP tools already default to headed — do not pass any `--headless` flag or configure a headless launch. If a tool call defaults to headless, find the headed alternative. Applies to all browser interactions: visual tests, WebGPU rendering checks, performance observations.

Note: even in headed mode, the virtual display caps RAF at 32Hz — watt/GPU% measurements still require a real browser opened by the user with `npm run gpu:hud`.
