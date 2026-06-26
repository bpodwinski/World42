# OCBT Lighting — Plan d'amélioration

## Round 1 — ✅ IMPLÉMENTÉ

### Axe A — Unifier le tone-mapping ✅

Triple ACES/Reinhard cascade supprimée. Les shaders `atmosphericScatteringFragmentShader.glsl` et `starRayMarchingFragmentShader.glsl` sortent désormais en **HDR linéaire**. Le seul opérateur ACES est dans `DefaultRenderingPipeline` (`toneMappingType=1`). `bloomWeight` réduit à 0.25 (bloom opère sur du vrai HDR).

**Fichiers modifiés :**
- `src/assets/shaders/atmosphericScatteringFragmentShader.glsl`
- `src/assets/shaders/stars/starRayMarchingFragmentShader.glsl`
- `src/core/render/postprocess_manager.ts`

---

### Axe B — Ambient runtime uniform + intensité étoile ✅

`CBT_AMBIENT` (constante bakée) remplacée par `uAmbient` (uniform runtime). `uLightIntensity` ajouté et câblé depuis `CbtPlanetOptions.starIntensity` → `OcbtSource` → `setLightIntensity()` per-frame.

**Fichiers modifiés :**
- `src/systems/lod/cbt/ocbt/ocbt_render_material.ts`
- `src/systems/lod/cbt/ocbt/ocbt_source.ts`
- `src/systems/lod/cbt/cbt_scheduler.ts`

---

### Axe C — AO de courbure procédural ✅

`CBT_AO_STRENGTH = 0.35`. `ao = 1.0 - CBT_AO_STRENGTH * clamp(1 - dot(nSlope, dir), 0, 1)`. Appliqué à `uAmbient` uniquement. Gated `uPerfMask` bit3. Basé sur `nSlope` (lissé à `CBT_SLOPE_DIST` km) pour un AO macro-forme (cratères/vallées), sans speckle micro-bump.

**Fichier modifié :** `src/systems/lod/cbt/ocbt/ocbt_render_material.ts`

---

### Axe D — Spéculaire GGX (terme D seul) ✅ → remplacé par Cook-Torrance complet (Round 2)

Premier GGX avec terme D uniquement et `CBT_SPEC_STRENGTH`. Remplacé en Round 2 (axe E) par le modèle complet D·F·G.

---

## Round 2 — ✅ IMPLÉMENTÉ

### Axe E — Cook-Torrance complet (D·F·G) ✅

Le GGX Round 1 n'utilisait que le terme NDF (`D`) — non conservateur en énergie. Ajout de :
- **Fresnel Schlick** : `F = CBT_F0 + (1−CBT_F0)·(1−VdH)⁵`, avec `CBT_F0 = 0.04` (roche diélectrique)
- **Smith-GGX geometry** : `G = G1(NdL)·G1(NdV)`, `k = alpha/2` (approximation IBL)
- Résultat : `spec = (D·F·G)/(4·NdL·NdV+ε)·NdL`

`CBT_SPEC_STRENGTH` supprimé. `CBT_F0` le remplace (physiquement fondé). Gated bit4.

**Fichier modifié :** `src/systems/lod/cbt/ocbt/ocbt_render_material.ts`

---

### Axe F — Aerial perspective in-shader (fog exponentiel) ✅

Deux uniforms runtime : `uAtmoDensity` (f32, défaut 0 = désactivé) et `uAtmoColor` (vec3).  
`fogFactor = exp(-uAtmoDensity · camDistKm · altFactor)` où `altFactor = clamp(1 - altKm/(CBT_RADIUS·0.01), 0, 1)`.  
Usage : corps **sans post-process atmosphérique** (Lune, astéroïdes avec poussière légère). Pour les planètes avec atmosphère complète, garder `uAtmoDensity = 0`.  
Setters : `setAtmoDensity()` / `setAtmoColor()` sur `OcbtRenderMaterial`.

**Fichier modifié :** `src/systems/lod/cbt/ocbt/ocbt_render_material.ts`

---

### Axe H — LightDirection en espace planète-local ✅

`uLightDirection` est maintenant transformé en espace planète-local avant `setLightDirection()` via `Vector3.TransformNormalToRef(worldDir, tmpInv, tmpLightLocal)`. `tmpInv` = inverse de `renderParentWorldMatrix`, déjà calculé en début de `requestUpdate()`. Sans rotation de `renderParent` (état actuel), c'est un no-op. Correct dès que la rotation planétaire sera câblée.

**Fichier modifié :** `src/systems/lod/cbt/ocbt/ocbt_source.ts`

---

## Axes futurs (non implémentés)

### Axe — Shadow pass GPU pour OCBT

**Priorité : P4 — Impact visuel maximal, complexité élevée**

Le terrain OCBT est rendu en indirect draw — `ShadowGenerator` Babylon ne supporte pas ce path. Options :

**Option A — Depth pre-pass compute** (recommandé) :
Compute shader qui rasterise le terrain depuis la direction lumière → depth texture utilisée comme shadow map dans le fragment. Intégration native WebGPU.

**Option B — Screen-space terrain self-shadow** :
Ray-march 4–8 steps en direction `-L` sur le height-field FBM depuis le fragment. Si la hauteur FBM dépasse le point actuel, le point est à l'ombre. Shadow portée ~2–10 km. Coût : 4–8 évals FBM/frag.

**Option C — Analytical pente** : `sin(elevation) < slope` → auto-shadow faces. Gratuit mais ne donne que de l'auto-ombre, pas de shadow portée cross-terrain.

**Fichiers à toucher :** `ocbt_render_material.ts` (option B/C), nouveau render pass WebGPU (option A).

---

### Axe — Multi-star lighting

**Priorité : P5 — Nécessaire pour Proxima b / Alpha Centauri**

`uLightDirection` est un `vec3` scalaire. Pour les systèmes binaires (Alpha Centauri A+B), il faut sommer deux contributions.

Plan : changer `uLightDirection` en `array<vec3<f32>, 2>`, ajouter `uLightColor[2]` et `uLightIntensity[2]` (ou struct array). Sommer `refl0 + refl1` et `spec0 + spec1` dans `fragmentSource()`. Adapter `setLightDirection()` pour accepter un tableau.

**Fichiers à toucher :** `ocbt_render_material.ts`, `ocbt_source.ts`, `stellar_catalog_loader.ts`.

---

## Invariants à respecter

- Tous les shaders sortent en **HDR linéaire** — un seul ACES dans `DefaultRenderingPipeline`.
- `uLightDirection` est en **espace planète-local** (pas WorldDouble, pas render-space).
- `uPerfMask` bits 0–4 sont réservés (slope normal / df64 ground / crater rays / AO / specular). Utiliser bit5+ pour les nouveaux blocs.
- Les baked constants ne peuvent pas changer sans rebuild du `ShaderMaterial`. Préférer un uniform quand la valeur varie per-planet ou à runtime.
- `V` = surface→camera (signe positif vers la caméra). `L` = surface→étoile = `normalize(-uLightDirection)`.
- `nSlope` (landform normal à `CBT_SLOPE_DIST` km) est utilisé pour l'AO et le slope-splatting. Ne pas le remplacer par `nLocal` (micro-bumps → speckle).
