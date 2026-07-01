---
name: bug-spawn-ignored-default-system
description: Fixed 2026-07-01 — spawn ignored data.json's "default" system, silently landing on Mercury/Sol (no profile), making the options-menu Apply a no-op with zero error
metadata:
  type: project
---

**Real root cause of "I change a value in the menu, click Apply, nothing happens, no crash"**
(reported 2026-07-01). Traced through several false leads (GPU device-hang, rebuildTerrain
synchronicity — see [gpu-device-hang-dense-topology](gpu-device-hang-dense-topology.md)) before
finding the actual bug, which had nothing to do with the GPU crash investigation.

**The bug:** `pickSpawnBody()` in `src/app/bootstrap_scene.ts` hardcoded
`loadedSystems.get('Sol') ?? loadedSystemsArr[0]` and `activeSystem.bodies.get('Mercury')`,
completely ignoring `data.json`'s top-level `"default"` field (e.g. `"Dev"`) despite CLAUDE.md
documenting `"default": "Dev"` as the active branch behavior. So with no `?system=`/`?planet=` URL
override, the app always spawned on **Mercury (Sol system)** — not the Dev Moon.

Mercury has no `"profile"` field in `data.json` (legacy path: global noise + its own lighting
override, per `stellar_catalog_loader.ts` ~line 297-305 — the profile-archetype branch only runs
`if (body.profile)`). Meanwhile the options menu (`create_floating_camera_scene.ts`) is hardcoded to
`initialProfileId: 'selena'`. Clicking "Apply" calls `lod.rebuildProfile('selena')`, which only
rebuilds planets whose `.profile === 'selena'` — Mercury's `.profile` is `undefined`, so the rebuild
loop silently skips every planet on screen. No error, no crash, just literally nothing to rebuild.

**Fix:** added `getDefaultSystemId(jsonSource)` to `stellar_catalog_loader.ts` (reads the
normalizer's `catalog.default`) and wired it into `pickSpawnBody()` so the declared default system
is tried first, before falling back to `'Sol'`. Confirmed via Playwright: after the fix, a fresh page
load spawns on the Dev Moon (visibly different terrain — real normal-map bump detail from
ground-detail-v1.md Step 3 clearly visible), and changing Seed + Apply now visibly reshuffles the
crater field (verified with a real before/after screenshot diff, not just "no console error").

**How to apply:** if `data.json`'s `"default"` is changed (e.g. back to `"Sol"` before merging to
`main`, per CLAUDE.md's Development Pipeline note), spawn will follow it correctly now. If the
options menu ever needs to edit whatever profile the player is ACTUALLY standing on (not just
hardcoded `'selena'`), that's a separate, not-yet-done improvement — `initialProfileId` in
`create_floating_camera_scene.ts` is still a hardcoded constant, not derived from `spawnBody`.

**Lesson for future debugging:** always verify a "does nothing" report with an actual before/after
visual diff (screenshot pixel comparison), not just "no console error" — this bug produced zero
errors and a perfectly normal-looking, functioning menu at every step (value persisted, Apply
handler fired, no exceptions) while doing precisely nothing useful, because the disconnect was
several layers removed from the code that was directly under suspicion (the crash investigation
was a red herring that consumed significant effort before this was found).
