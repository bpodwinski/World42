---
name: atmosphere-integration
description: World42 physically-based (single-scattering) atmosphere as a Frame Graph task — design + gotchas
metadata: 
  node_type: memory
  type: project
---

Added a **physically-based single-scattering atmosphere** (Rayleigh + Mie) as a custom Frame Graph task (NOT the `@babylonjs/addons` Atmosphere). Validated 2026-06-26: Earth from ground = blue sky + warm Mie horizon haze + aerial perspective; from orbit = blue disc + bright blue limb. Airless bodies (atmosphere=null) → task not added. Builds on [[frame-graph-integration]].

**Pipeline:** analytic ray-march post-process between Star and TAA (HDR linear, before bloom/ACES). Reconstructs the view ray from inverse proj/view, intersects the atmosphere shell + planet sphere, ray-marches 24 view × 6 light steps (exp density, Rayleigh phase + Mie HG, transmittance).

**Shaders:** native WGSL (`atmosphereFragmentShader.wgsl`, `starRayMarchingFragmentShader.wgsl`). Babylon 9 WGSL post-process convention: header `varying vUV: vec2f; var textureSamplerSampler: sampler; var textureSampler: texture_2d<f32>;`, uniforms via `uniforms.x`, entry `@fragment fn main(input: FragmentInputs)->FragmentOutputs`.

**KEY DESIGN CALL — no depth sampling:** Frame Graph depth attachment (DEPTH32_FLOAT) can't be sampled as a color texture in WebGPU — `texture2D(depthSampler,uv).r` returned the cleared 1.0 everywhere. Atmosphere bounds the surface with the **analytic planet sphere** instead. ⚠️ The **star pass terrain-occlusion depth read is ALSO broken** for the same reason — sun likely isn't occluded by terrain (TODO, separate task).

**Three gotchas (historical, now obsolete since WGSL migration):**
1. `stellar_catalog_normalizer.normalizeSystemJSON` never copied `lighting` → always undefined → every lighting block silently fell back to defaults. FIX: pass `lighting` through in the normalizer.
2. `vec3 + float` is illegal in strict GLSL ES 3.00. FIX: `vec3(mieScalarTerm)`.
3. Trailing comments on `uniform` lines break the WebGPU UBO reorg in Babylon's GLSL path → "syntax error, unexpected INTCONSTANT". RULE (GLSL only): never put a comment after `uniform ...;`.

**Dev URL params:** `?system=Dev&planet=Earth` loads just Dev and spawns on Earth → instant atmosphere view. `?system=<id>` + `?planet=<name>` added in `bench_override.ts` + `bootstrap_scene.ts`.
