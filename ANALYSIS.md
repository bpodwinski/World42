# Analyse complète du projet World42

> Mise à jour : 2026-03-03 | Version codebase : 0.0.5

## Contexte

World42 est un **moteur de rendu planétaire temps réel en 1:1**, construit avec **BabylonJS 8.51.1**, **TypeScript strict** et un générateur de terrain en **Rust/WASM**. Le projet implémente un système de LOD (Level of Detail) CDLOD par quadtree sur une quad-sphère, avec une caméra à origine flottante pour maintenir la précision numérique à des échelles interplanétaires.

- **Version :** 0.0.5
- **Demo live :** https://bpodwinski.github.io/World42/
- **Type :** SPA statique (sans serveur ni base de données)
- **Bundler :** Rspack 1.5.8
- **Tests :** Vitest 4.0.5

---

## 1. Architecture globale

Le projet suit une architecture en couches à sens unique. Les dépendances vont exclusivement vers le bas.

```
src/
├── app/                        # Bootstrap scène (nouveauté v0.0.5)
│   ├── bootstrap_scene.ts      # Initialisation scène, caméra, GUI, contrôles, debug cam
│   ├── create_floating_camera_scene.ts
│   ├── setup_lod_and_shadows.ts
│   └── setup_runtime.ts
│
├── core/                       # Sous-systèmes moteur (0 dépendance jeu)
│   ├── camera/
│   │   ├── camera_manager.ts   # OriginCamera (floating-origin, doublepos, toRenderSpace)
│   │   └── teleport_entity.ts  # Utilitaire téléportation
│   ├── control/
│   │   └── mouse_steer_control_manager.ts  # Contrôles 6DOF vaisseau
│   ├── gui/
│   │   ├── gui_manager.ts
│   │   └── components/         # center_crosshair, mouse_crosshair, speed_hud
│   ├── io/
│   │   └── texture_manager.ts  # Chargement KTX2
│   ├── lifecycle/              # NOUVEAU — gestion cycle de vie
│   │   └── disposable_registry.ts  # Enregistrement centralisé des teardowns
│   ├── render/
│   │   ├── engine_manager.ts
│   │   ├── postprocess_manager.ts
│   │   └── star_raymarch_postprocess.ts
│   └── scale/
│       └── scale_manager.ts    # SEUL point de conversion km ↔ sim units
│
├── systems/                    # Systèmes réutilisables (dépendent de core)
│   └── lod/
│       ├── types.ts            # NOUVEAU — types communs (Bounds, Face)
│       ├── lod_scheduler.ts    # Tick LOD, budget frame, round-robin multi-planètes
│       ├── lod_priority_queue.ts
│       ├── chunks/
│       │   ├── chunk_tree.ts          # Nœud CDLOD : split/merge/worker request
│       │   ├── chunk_metrics.ts       # Calcul SSE, isSphereInFrustum
│       │   ├── chunk_forge.ts         # Construction mesh BabylonJS depuis données worker
│       │   ├── chunk_geometry.ts      # NOUVEAU — géométrie chunk isolée
│       │   ├── chunk_culling_eval.ts  # NOUVEAU — évaluation culling (CullResult typé)
│       │   ├── chunk_lod_eval.ts      # NOUVEAU — évaluation LOD séparée
│       │   ├── backside_culling.ts    # NOUVEAU — culling horizon/backside isolé
│       │   └── frustum_culling.ts     # NOUVEAU — frustum culling isolé
│       └── workers/
│           ├── worker_pool.ts
│           ├── global_worker_pool.ts  # NOUVEAU — singleton pool partagé
│           ├── priority_queue.ts      # NOUVEAU — file de priorité dédiée
│           ├── terrain_mesh_worker.ts
│           └── worker_protocol.ts
│
├── game_objects/               # Entités domaine
│   └── planets/rocky_planet/
│       ├── terrain.ts
│       ├── terrains_shader.ts
│       └── atmospheric-ccattering-postprocess.ts
│
├── game_world/                 # Logique de jeu (couche la plus haute)
│   └── stellar_system/
│       ├── data.json                        # Catalogue Sol + Alpha Centauri
│       ├── stellar_catalog_loader.ts
│       └── stellar_catalog_normalizer.ts    # NOUVEAU — normalisation/validation JSON
│
├── assets/shaders/             # GLSL (terrain vertex/fragment, étoiles, atmosphère)
├── types/                      # Déclarations TypeScript (.d.ts)
└── utils/                      # Utilitaires (sun_glare, etc.)

terrain/                        # Crate Rust compilée en WASM
└── src/lib.rs                  # build_chunk() — export WASM principal
```

**Fichiers TypeScript :** ~50 fichiers source + 4 fichiers de test + 5 shaders GLSL + 1 crate Rust

---

## 2. Espaces de coordonnées

Trois espaces coexistent. Chaque calcul doit n'en utiliser qu'un seul. La conversion passe **obligatoirement** par `ScaleManager` ou les méthodes de la caméra.

| Espace | Propriétés/Méthodes | Usage |
|--------|---------------------|-------|
| **WorldDouble** | `camera.doublepos`, `entity.doublepos`, `body.positionWorldDouble` | LOD (SSE), culling backside/horizon, distances interplanétaires |
| **Render-space** | `mesh.position`, `camera.position ≈ 0`, frustum planes | Rendu GPU, frustum culling, post-processing, shadow maps |
| **Planet-local** | Sorties workers WASM, uniforms shader | Génération terrain, bounding spheres, transfer vers WorldDouble |

Conversion : `ScaleManager.toSimulationUnits(km)` · `camera.toRenderSpace(worldDouble, out)`

---

## 3. Systèmes techniques clés

### 3.1 Caméra à origine flottante (`OriginCamera`)

| Aspect | Détail |
|--------|--------|
| **Problème résolu** | Perte de précision float32 aux grandes distances planétaires |
| **Mécanisme** | La caméra render est toujours à (0,0,0) ; la position réelle est stockée dans `doublepos` |
| **Par frame** | Delta render accumulé → `doublepos`, puis reset render à l'origine |
| **API** | `doublepos`, `toRenderSpace(wd, out)`, `toWorldSpace(renderPos)`, `distanceToSim(wd)` |
| **Entités** | `FloatingEntity` : `node.position` recalculé en Render-space chaque frame |

### 3.2 Système CDLOD (LodScheduler + ChunkTree)

| Paramètre | Valeur |
|-----------|--------|
| Algorithme | SSE : `ssePx = error * K / distance` |
| Seuil split | `ssePx > 5.0 px` |
| Seuil merge | `ssePx < 4.0 px` (hystérésis) |
| Structure | 6 faces cube (quad-sphère), subdivision récursive |
| Niveaux LOD | 0 à 12 (`maxLevel=12`) |
| Résolution | 96 vertices/côté (~9 409 verts/chunk) |
| Culling | Frustum (guard-band de prefetch) + backside/horizon |

**Scheduler (`lod_scheduler.ts`) :**
- Branché sur `onBeforeRenderObservable` (plus de boucle while infinie)
- Budget frame : `budgetMs=30`, `maxConcurrent=8`, `maxStartsPerFrame=2`
- Round-robin multi-planètes
- Rescore périodique : `rescoreMs=100`

**Évaluation du culling (`chunk_culling_eval.ts`) :**
- `CullResult` : flags `drawStrict`, `inPrefetch`, `frustumStrict`, `frustumPrefetch`, `horizonStrict`, `horizonPrefetch`
- Guard-band de prefetch configurable (`frustumPrefetchScale`, `horizonPrefetchScale`)
- Conversion WorldDouble → Render-space explicite avant test frustum

### 3.3 Workers et WASM

- **Protocole :** `mesh-kernel/1` — `init → ready`, `build_chunk → chunk_result`, `cancel`
- **Pool :** `WorkerPool` avec `hardwareConcurrency - 1` threads, exposed via `globalWorkerPool` (singleton)
- **File de priorité :** min-heap par distance caméra, rescore périodique
- **Types communs :** `Bounds` (uMin/uMax/vMin/vMax), `Face` (front/back/left/right/top/bottom)
- **Terrain Rust :** Perlin noise (seed, octaves, fréquence, amplitude, lacunarité, persistance)
- **Données retournées :** `Float32Array` (positions, normals, uvs) + `Uint32Array` (indices) + bounding sphere

### 3.4 Cycle de vie (`DisposableRegistry`)

Nouveau système centralisé de teardown :
- `add(disposer)` : enregistre une fonction de nettoyage
- `addDomListener(target, type, listener)` : wrapping typé de `addEventListener/removeEventListener`
- `addBabylonObserver(observable, observer)` : suppression automatique d'observateurs BabylonJS
- `dispose()` : exécute tous les teardowns en ordre inverse (LIFO)

### 3.5 Normalisation du catalogue (`stellar_catalog_normalizer.ts`)

Couche de validation et normalisation du JSON d'entrée :
- Canonicalise le champ `type` (`"sun"` → `"star"`, casse insensible)
- Valide et coerce `position_km`, `diameter_km`, `rotation_period_days`, `star.*`
- Prend en charge les deux formats JSON (nouveau `systems` + ancien format plat)
- Sans dépendance BabylonJS

### 3.6 Pipeline de rendu

| Étape | Implémentation | Fichier |
|-------|---------------|---------|
| Moteur | WebGPU avec fallback WebGL2 | `engine_manager.ts` |
| Tone mapping | ACES | `postprocess_manager.ts` |
| Bloom | BabylonJS built-in | `postprocess_manager.ts` |
| Anti-aliasing | FXAA + MSAA 4x | `postprocess_manager.ts` |
| Sharpen | Custom post-process | `postprocess_manager.ts` |
| Étoiles | Ray-marching SDF (100 steps) | `star_raymarch_postprocess.ts` |
| Atmosphère | Rayleigh + Mie scattering | `atmospheric-ccattering-postprocess.ts` |
| Ombres | ShadowGenerator 4096px, PCF3x3, portée dynamique | `setup_lod_and_shadows.ts` |

### 3.7 Bootstrap et caméra debug

`bootstrap_scene.ts` orchestre le démarrage de la scène :
- Charge tous les systèmes stellaires depuis `data.json`
- Crée la caméra principale (`OriginCamera`) et la caméra debug (`UniversalCamera`)
- Vue PiP (Picture-in-Picture) : caméra debug en miniature (viewport coin supérieur droit)
- Contrôles debug : IJKL + UO pour naviguer la caméra secondaire
- Tous les abonnements passent par `DisposableRegistry`

### 3.8 Contrôles joueur (6DOF)

- **Souris :** Yaw/Pitch avec dead-zone (50px) et courbe de réponse
- **Clavier :** Z/S (avant/arrière), Q/D (strafe), R/F (haut/bas), E/A (roll)
- **Modificateurs :** Shift (boost), Ctrl (frein)
- **Raccourcis debug :** L (LOD visualization), ² (BabylonJS Inspector), T (téléport Alpha Centauri)

---

## 4. Shaders GLSL

| Shader | Rôle |
|--------|------|
| `terrain/terrainVertexShader.glsl` | Déformation vertices, normales, blending LOD |
| `terrain/terrainFragmentShader.glsl` | Texturing diffuse+detail, éclairage, ombres PCF3x3 |
| `terrain/_terrainDebugLOD.glsl` | Visualisation colorée niveaux LOD |
| `stars/starRayMarchingFragmentShader.glsl` | Halo lumineux étoiles (SDF) |
| `atmosphericScatteringFragmentShader.glsl` | Diffusion Rayleigh + Mie volumétrique |

---

## 5. Données et catalogue stellaire

**Fichier :** `src/game_world/stellar_system/data.json`

- Systèmes : Sol (8 planètes + lunes), Alpha Centauri (Proxima b)
- Format corps : `{ type, position_km, diameter_km, rotation_period_days, star? }`
- Chargement : `stellar_catalog_loader.ts` → normalisation via `stellar_catalog_normalizer.ts`
- Support multi-format JSON (nouveau format `{ systems: {...} }` et ancien format plat)

---

## 6. Dépendances

### Production (TypeScript/JS)

| Package | Version | Rôle |
|---------|---------|------|
| `@babylonjs/core` | ^8.51.1 | Moteur 3D principal |
| `@babylonjs/gui` | ^8.51.1 | Interface utilisateur |
| `@babylonjs/inspector` | ^8.51.1 | Debug inspector |
| `@babylonjs/ktx2decoder` | ^8.51.1 | Décodage textures KTX2 |
| `@babylonjs/loaders` | ^8.51.1 | Chargement de modèles |
| `@babylonjs/materials` | ^8.51.1 | Matériaux intégrés |
| `dotenv` | ^17.2.3 | Variables d'environnement |

### Dev

| Package | Version | Rôle |
|---------|---------|------|
| `@rspack/core` | ^1.5.8 | Bundler principal |
| `vitest` | ^4.0.5 | Tests unitaires |
| `@vitest/coverage-v8` | ^4.0.5 | Couverture de code |
| `ts-checker-rspack-plugin` | ^1.1.6 | Type-checking Rspack |

### Rust/WASM (`terrain/`)

| Crate | Rôle |
|-------|------|
| `wasm-bindgen 0.2` | Bridge WASM/JS |
| `noise 0.9` | Bruit de Perlin/Simplex |
| `js-sys 0.3` | Bindings JavaScript |

---

## 7. Tests et qualité

| Fichier de test | Couverture |
|-----------------|------------|
| `core/scale/scale_manager.test.ts` | Conversions km ↔ sim units |
| `core/lifecycle/disposable_registry.test.ts` | NOUVEAU — cycle de vie, teardowns LIFO |
| `game_world/stellar_system/stellar_catalog_normalizer.test.ts` | NOUVEAU — normalisation JSON catalogue |
| `systems/lod/workers/worker_protocol.test.ts` | NOUVEAU — protocole `mesh-kernel/1` |

- **Framework :** Vitest 4.0.5 (environnement Node, sans DOM)
- **Couverture :** `src/**/*.{ts,tsx}` → text + HTML (`/coverage/`)
- **CI/CD :** Non configuré
- **Linting :** Prettier (`single quotes`, `semi`, `printWidth: 80`)

---

## 8. État des priorités (comparaison avant/après)

| Priorité | Problème | Statut |
|----------|----------|--------|
| **P0** | Incohérences d'unités (km vs sim) | **RÉSOLU** — espaces de coordonnées unifiés, `ScaleManager` enforced |
| **P1** | Boucle LOD non budgétisée | **RÉSOLU** — `LodScheduler` sur `onBeforeRenderObservable` + budget `budgetMs=30` + round-robin |
| **P2** | `ChunkTree` trop de responsabilités | **EN COURS** — découpage en `chunk_culling_eval`, `chunk_lod_eval`, `chunk_geometry`, `backside_culling`, `frustum_culling` |
| **P3** | 1 material par chunk | **OUVERT** — draw calls élevés, overhead GPU |
| **P4** | Pas de déduplication worker | **PARTIELLEMENT** — `globalWorkerPool` singleton introduit ; dedup/cancel queue non encore implémentés |

---

## 9. Points forts actuels

1. **Floating-origin** fonctionnel — précision maintenue à l'échelle 1:1
2. **Génération terrain async** (Workers + WASM) — main thread non bloqué
3. **LodScheduler budgété** avec round-robin — plus de boucle infinie, budget 30ms/frame
4. **ScaleManager centralisé** — seul point de conversion km ↔ sim units
5. **Protocole worker typé** (`mesh-kernel/1`) avec support d'annulation
6. **Culling modulaire** — frustum, backside et évaluation combinée séparés, types explicites (`CullResult`)
7. **DisposableRegistry** — gestion unifiée du cycle de vie, élimination des fuites mémoire
8. **Normalisation catalogue** — validation et coercion du JSON, support multi-format
9. **Couverture tests améliorée** — 4 fichiers de test (vs 1 précédemment)
10. **Multi-systèmes stellaires** (Sol, Alpha Centauri) depuis catalogue JSON
11. **Pipeline post-processing complet** (bloom, ACES, FXAA, atmosphère, ombres PCF3x3)
12. **Compatibilité WebGPU** avec fallback WebGL2
13. **Caméra debug PiP** — vue miniature indépendante pour le développement

---

## 10. Points d'amélioration restants

### Architecturaux (ouverts)

| Priorité | Problème | Recommandation |
|----------|----------|----------------|
| **P2** | `ChunkTree` encore trop de responsabilités | Finaliser la séparation : `ChunkNode` (données pures) + `ChunkMeshService` + `ChunkTransitions` |
| **P3** | 1 material par chunk | `TerrainMaterialService` : 1 material/planète partagé via `onBindObservable` |
| **P4** | Pas de déduplication worker | `MeshKernelClient` : dedup par `chunkKey` + cancel queue in-flight |

### Qualité et outillage

| Aspect | Observation |
|--------|-------------|
| **Couverture tests** | Progression notable (4 fichiers) mais systèmes LOD et rendu non couverts |
| **CI/CD** | Aucun pipeline automatisé (GitHub Actions, lint, build check) |
| **Typo fichier** | `atmospheric-ccattering-postprocess.ts` (double 'c') — conservé pour compatibilité |
| **Error handling** | Minimal dans les workers et le chargement d'assets |

### Roadmap technique (`todo.txt`)

1. Pool d'objets pour les nodes (éviter les `dispose()` excessifs)
2. Heightmap CPU via Web Worker dédié
3. Génération GPU des chunks via WebGPU compute shaders
4. Streaming de textures depuis le cloud
5. Projection UV équirectangulaire dans les shaders
6. UV triplanaire dans les shaders
7. Timeout de génération basé sur la vitesse caméra (éviter de charger au moindre mouvement)

---

## 11. Résumé

| Caractéristique | Valeur |
|-----------------|--------|
| **Type** | Moteur de rendu planétaire client-side |
| **Langage** | TypeScript strict + Rust (WASM) |
| **Moteur 3D** | BabylonJS 8.51.1 |
| **Bundler** | Rspack 1.5.8 |
| **Rendu** | WebGPU / WebGL2 |
| **Serveur** | Aucun (SPA statique) |
| **Base de données** | Aucune (catalogue JSON) |
| **Tests** | 4 fichiers (scale, lifecycle, catalogue, protocole) |
| **CI/CD** | Non configuré |
| **Déploiement** | GitHub Pages |
| **Fichiers source TS** | ~50 fichiers TypeScript + 5 GLSL + 1 crate Rust |
