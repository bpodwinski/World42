# OCBT Lighting — Plan d'amélioration

État de départ : Lambert + Lommel-Seeliger + opposition surge + albedo procédural slope/altitude + df64 micro-relief. Aucune ombre portée. Ambient baked. Tone-mapping incohérent entre shaders.

---

## Axe 1 — Unifier ambient et tone-mapping

**Priorité : P1 — Quick win, zéro risque visuel**

### Problème

`CBT_AMBIENT` est baked dans `bakedHeader()` avec un défaut de `(0.008, 0.008, 0.008)`. Changer la valeur per-planet nécessite un `dispose()` + rebuild du `ShaderMaterial`, ce qui force un flash.

Le tone-mapping est appliqué 3 fois en cascade avec des opérateurs différents :
- `atmosphericScatteringFragmentShader.glsl` : ACES (`acesTonemap()`) + exposition 1.2 + saturation 1.2
- `starRayMarchingFragmentShader.glsl` : Reinhard simple
- `DefaultRenderingPipeline` (Babylon) : Reinhard (type 1), exposition 1.2

Le signal HDR du terrain OCBT est donc tone-mappé deux fois (atmo ACES puis pipeline Reinhard).

### Plan

**Ambient :**
1. Retirer `CBT_AMBIENT` de `bakedHeader()`.
2. Ajouter `uniform uAmbient : vec3<f32>;` dans `fragmentSource()`.
3. Ajouter `'uAmbient'` dans l'array `uniforms` de `buildOcbtRenderMaterial`.
4. Exposer `setAmbient(v: Vector3)` sur `OcbtRenderMaterial`.
5. Lire `ambient` depuis `data.json` (champ à ajouter sur les corps planétaires) et appeler `setAmbient` dans le tick OCBT.

**Tone-mapping :**
1. Retirer l'appel ACES (`acesTonemap()`) de `atmosphericScatteringFragmentShader.glsl` — laisser la sortie en HDR linéaire.
2. Retirer le tone-map custom du `starRayMarchingFragmentShader.glsl` — laisser en HDR.
3. Configurer `DefaultRenderingPipeline` avec ACES (`imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES`) et `imageProcessing.exposure` comme seul point de contrôle.

**Fichiers touchés :**
- `src/systems/lod/cbt/ocbt/ocbt_render_material.ts`
- `src/assets/shaders/atmosphericScatteringFragmentShader.glsl`
- `src/assets/shaders/stars/starRayMarchingFragmentShader.glsl`
- `src/core/render/postprocess_manager.ts`
- `src/game_world/stellar_system/data.json`

**Test de régression :** le ciel diurne ne doit pas saturer en blanc. La luminosité globale de la planète ne doit pas changer de plus de 15%.

---

## Axe 2 — AO de courbure procédural (self-shadow sans shadow map)

**Priorité : P2 — Impact visuel important, 0 dépendance externe**

### Problème

Les vallées, cratères et faces ombragées des collines n'ont aucun assombrissement indirect. La surface paraît plate à moyenne altitude (2–50 km).

### Approche

Le gradient analytique FBM est déjà calculé dans `cbtNoiseNormalAt()`. La courbure locale peut en être dérivée sans échantillonnage supplémentaire :

```wgsl
// AO approché par divergence de la normale (sphérique)
// nLocal = normal de surface, dir = direction radiale (up)
let curvature = clamp(1.0 - dot(nLocal, dir), 0.0, 1.0);
// curvature ≈ 0 sur terrain plat/convexe, > 0 dans les creux/concaves
let ao = 1.0 - CBT_AO_STRENGTH * curvature;
```

Pour un résultat plus précis, un **horizon AO directionnel** (3–5 samples dans la direction solaire sur le height-field local) peut compléter sans ray-cast GPU général.

### Plan

1. Dans `fragmentSource()`, après le calcul de `nLocal`, calculer `curvature = clamp(1.0 - dot(nLocal, dir), 0.0, 1.0)`.
2. Ajouter `const CBT_AO_STRENGTH : f32 = 0.35;` dans `bakedHeader()`.
3. Multiplier `CBT_AMBIENT` par `mix(1.0 - CBT_AO_STRENGTH, 1.0, 1.0 - curvature)` (l'AO assombrit l'ambient, pas la lumière directe).
4. Câbler dans `uPerfMask` bit3 pour mesurer le coût GPU isolé.

**Variante avancée (horizon-based) :** émettre 4 samples à `dir + epsilon * tangent_i` dans la direction de `L` sur le height-field procédural, comparer les hauteurs pour estimer l'horizon angle. Coût : 4 évaluations FBM supplémentaires.

**Fichiers touchés :**
- `src/systems/lod/cbt/ocbt/ocbt_render_material.ts` (bakedHeader + fragmentSource)

**Test de régression :** les cratères doivent s'assombrir légèrement au fond sans saturer en noir. La surface plate doit rester identique (curvature ≈ 0 → ao ≈ 1.0).

---

## Axe 3 — Spéculaire GGX (micro-facettes)

**Priorité : P3 — Gain visuel à basse altitude, implique V déjà disponible**

### Problème

Aucun highlight solaire. L'eau gelée, la glace, les cratères frais (haute albedo) paraissent matés à toute altitude.

### Approche

V est **déjà calculé** dans le fragment shader OCBT :
```wgsl
let V = normalize(-(uniforms.world * vec4<f32>(rel, 0.0)).xyz);
```

NdV est aussi disponible (utilisé pour Lommel-Seeliger). Un GGX simplifié ne nécessite que H = normalize(L + V) et NdH :

```wgsl
// GGX specular (Trowbridge-Reitz, simplified)
let H = normalize(L + V);
let NdH = max(dot(nWorld, H), 0.0);
let alpha = CBT_ROUGHNESS * CBT_ROUGHNESS;
let denom = NdH * NdH * (alpha * alpha - 1.0) + 1.0;
let D = (alpha * alpha) / (3.14159 * denom * denom);
// Combine: visibility term omitted (cost vs. gain tradeoff)
let spec = D * CBT_SPEC_STRENGTH * NdL;
```

`roughness` peut être dérivé du même pipeline procédural que l'albedo : `roughness = mix(CBT_ROUGH_LO, CBT_ROUGH_HI, slope01)` (surfaces plates = plus lisses, pentes raides = rugueuses).

### Plan

1. Ajouter dans `bakedHeader()` :
   - `const CBT_ROUGHNESS : f32 = 0.6;` (default, sera conduit par slope)
   - `const CBT_SPEC_STRENGTH : f32 = 0.05;` (faible pour régolithe)
2. Dans `fragmentSource()`, après le calcul de `refl`, ajouter le bloc GGX.
3. Ajouter `spec` à `fragmentOutputs.color` : `albedo * lighting + CBT_LIGHTCOLOR * spec`.
4. Variante slope-driven : `let roughness = mix(0.3, 0.85, slope01);` (plus lisse sur les flats).
5. Câbler dans `uPerfMask` bit4.

**Note :** pour un planet airless (Lune), le spéculaire doit rester très faible (`CBT_SPEC_STRENGTH` ≈ 0.02–0.08). Pour une planète avec eau ou glace, monter à 0.15–0.4.

**Fichiers touchés :**
- `src/systems/lod/cbt/ocbt/ocbt_render_material.ts` (bakedHeader + fragmentSource)

---

## Axe 4 — Shadow pass GPU pour OCBT

**Priorité : P4 — Impact visuel maximal, complexité architecturale élevée**

### Problème

Le terrain OCBT est rendu en **indirect draw** depuis un buffer GPU (compacted live-slot list). Les `ShadowGenerator` Babylon.js ne supportent pas les meshes rendus par draw indirect — ils ne peuvent pas construire la shadow map depuis ce path.

### Options

**Option A — Depth pre-pass compute** (recommandé à terme) :
- Ajouter un compute shader qui rasterise le terrain OCBT dans un depth texture depuis la direction lumière.
- Utiliser ce depth buffer comme shadow map dans le fragment shader.
- Avantage : intégration native WebGPU, pas de dépendance Babylon.
- Coût : ≈ 1 pass compute (~2ms) + 1 sampler dans le fragment.

**Option B — Screen-space soft shadow** :
- Dans le fragment shader, marcher quelques steps en direction lumière sur le height-field procédural FBM.
- Si la hauteur FBM le long du rayon dépasse la surface, le point est à l'ombre.
- Avantage : zéro infrastructure GPU supplémentaire.
- Limitation : shadow portée ≈ 2–10 km, artefacts aux grandes altitudes.
- Coût : 4–8 évaluations FBM supplémentaires.

**Option C — Analytical shadow (pentes)** :
- Calculer l'angle d'élévation solaire (`asin(NdL)`) et comparer à la pente locale.
- Auto-shadow sur les faces exposées, pas de shadow portée cross-terrain.
- Coût : 0 évaluation supplémentaire.

### Plan (option B, court terme)

```wgsl
// Screen-space terrain self-shadow: march 6 steps along L on the sphere surface
const CBT_SSAO_STEPS : i32 = 6;
const CBT_SSAO_STEP_KM : f32 = 2.0;    // step size in km
const CBT_SSAO_STRENGTH : f32 = 0.6;

fn ocbtSelfShadow(dir: vec3<f32>, L: vec3<f32>) -> f32 {
    var shadow = 1.0;
    var marchDir = dir;
    for (var i = 1; i <= CBT_SSAO_STEPS; i++) {
        marchDir = normalize(marchDir + L * (CBT_SSAO_STEP_KM / CBT_RADIUS));
        let h = fbmHeight(marchDir);        // reuse existing FBM
        let surfH = length(dir) * CBT_RADIUS + h;
        let sampleH = length(marchDir) * CBT_RADIUS + fbmHeight(marchDir);
        // Above current surface -> partially blocked
        // (simplified: compare altitudes along the march)
    }
    return shadow;
}
```

L'implémentation complète de l'option A sera traitée dans une tâche dédiée (nécessite un WebGPU render pass séparé et une shadow texture).

**Fichiers touchés :**
- `src/systems/lod/cbt/ocbt/ocbt_render_material.ts`
- `src/app/setup_lod_and_shadows.ts` (pour option A : nouveau render pass)

---

## Axe 5 — Multi-star lighting

**Priorité : P5 — Nécessaire pour Proxima b / Alpha Centauri, architectural**

### Problème

`uLightDirection` est un scalaire `vec3`. Le catalogue `data.json` contient Proxima Centauri et Alpha Centauri A/B, mais la planète Proxima b ne reçoit qu'une seule source lumineuse (la plus proche).

### Plan

1. Changer `uLightDirection` en `array<vec3<f32>, 2>` (WebGPU supporte les array uniforms).
2. Ajouter `uLightColor0`, `uLightColor1`, `uLightIntensity0`, `uLightIntensity1` — ou un struct array.
3. Dans `fragmentSource()`, sommer les contributions : `refl = refl0 + refl1` (pas d'occlusion inter-étoile à cette échelle).
4. Dans `ocbt_topology_kernel.ts` / `ocbt_render_material.ts`, adapter `setLightDirection` pour accepter un tableau.
5. Dans `stellar_catalog_loader.ts`, collecter toutes les étoiles à moins de N UA et les passer au matériau.

**Note :** le spéculaire (Axe 3) doit être summé par étoile aussi si implémenté.

**Fichiers touchés :**
- `src/systems/lod/cbt/ocbt/ocbt_render_material.ts`
- `src/systems/lod/cbt/ocbt/ocbt_topology_kernel.ts`
- `src/game_world/stellar_system/stellar_catalog_loader.ts`

---

## Ordre recommandé

```
Axe 1 (ambient uniform + tone-mapping)   ← commencer ici, quick win
  │
  ▼
Axe 2 (AO courbure procédural)           ← 0 dépendance externe, pure shader
  │
  ▼
Axe 3 (spéculaire GGX)                  ← V déjà disponible, faible risque
  │
  ▼
Axe 4 (shadow portée)                    ← architectural, option B d'abord
  │
  ▼
Axe 5 (multi-star)                       ← en dernier, nécessite refactor uniform
```

## Invariants à respecter

- Ne jamais mélanger les espaces de coordonnées dans un calcul lighting (tout doit être en world-space après `mat3(world) * nLocal`).
- `uPerfMask` : les bits existants 0/1/2 sont réservés (slope normal / df64 ground / crater rays). Utiliser bit3+ pour les nouveaux blocs.
- Les baked constants ne peuvent pas être changées sans rebuild du `ShaderMaterial`. Préférer un uniform quand la valeur doit varier per-planet ou à runtime.
- Le `V` calculé dans le fragment est `surface→camera` (pas `camera→surface`) — vérifier le signe avant d'utiliser dans GGX.
