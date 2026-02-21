# CLAUDE.md — Guide de référence pour World42

## Vue d'ensemble

**World42** est un moteur de rendu planétaire temps réel 1:1, conçu pour explorer des surfaces planétaires à toute altitude (du sol jusqu'à l'espace). Il implémente un système CDLOD (Continuous Distance-based Level of Detail) par quadtree sur une quad-sphère, avec une caméra à origine flottante pour maintenir la précision numérique aux échelles interplanétaires.

- **Version :** 0.0.5
- **Demo live :** https://bpodwinski.github.io/World42/
- **Type :** SPA statique (pas de serveur, pas de base de données)

---

## Tech stack

| Composant | Technologie | Version |
|-----------|-------------|---------|
| Rendu 3D | BabylonJS | 8.51.1 |
| Langage principal | TypeScript (strict) | ESNext |
| Terrain procédural | Rust + wasm-bindgen | edition 2024 |
| Bruit de terrain | `noise` crate (Perlin/Simplex) | 0.9 |
| Bundler | Rspack | 1.5.8 |
| Tests | Vitest | 4.0.5 |
| Rendu GPU | WebGPU (fallback WebGL2) | — |
| Déploiement | GitHub Pages | — |

---

## Commandes de développement

```bash
# TypeScript
npm run serve       # Dev server → http://localhost:19300
npm run build       # Build production → /dist
npm run deploy      # Deploy GitHub Pages (nécessite un build préalable)
npm test            # Vitest (watch mode)
npm run coverage    # Rapport couverture (text + HTML dans /coverage)

# Rust/WASM (exécuter dans le répertoire terrain/)
wasm-pack build --dev --target web --out-dir pkg     # Build WASM dev
wasm-pack build --release --target web --out-dir pkg  # Build WASM release
```

> **Important :** Les assets skybox sont chargés depuis `process.env.ASSETS_URL`. Créer un `.env` à la racine avec `ASSETS_URL=...` et `SCALE_FACTOR=...` avant de lancer le dev server.

---

## Architecture en couches

Les dépendances ne vont que dans un sens (vers le bas) :

```
src/
├── core/               # Sous-systèmes moteur réutilisables (0 dépendance jeu)
│   ├── camera/         # OriginCamera (floating-origin), FloatingEntity
│   ├── control/        # MouseSteerControlManager (contrôles 6DOF vaisseau)
│   ├── gui/            # GuiManager, crosshair, HUD vitesse
│   ├── io/             # TextureManager (KTX2), AssetLoader
│   ├── render/         # EngineManager, PostProcessManager, star ray-marching
│   └── scale/          # ScaleManager — SEUL point de conversion km ↔ sim
│
├── systems/            # Systèmes réutilisables (dépendent de core)
│   └── lod/
│       ├── chunks/     # ChunkTree, chunk_metrics, chunk_forge, culling
│       ├── workers/    # WorkerPool, protocole mesh-kernel/1, MinHeap
│       ├── lod_scheduler.ts
│       └── lod_priority_queue.ts
│
├── game_objects/       # Entités domaine (dépendent de core + systems)
│   └── planets/rocky_planet/
│       ├── terrain.ts                              # RockyPlanet
│       ├── terrains_shader.ts                      # TerrainShader + TerrainShadowContext
│       └── atmospheric-ccattering-postprocess.ts   # Rayleigh + Mie
│
├── game_world/         # Logique de jeu (couche la plus haute)
│   └── stellar_system/
│       ├── data.json                   # Catalogue Sol + Alpha Centauri
│       └── stellar_catalog_loader.ts   # Parse JSON + crée la scène
│
├── assets/shaders/     # GLSL (terrain vertex/fragment, stars, atmosphere)
├── types/              # Déclarations TypeScript (.d.ts)
└── utils/              # Utilitaires divers (sun_glare, etc.)

terrain/                # Crate Rust compilée en WASM
└── src/lib.rs          # build_chunk() — export WASM principal
```

---

## Espaces de coordonnées (règle d'or)

Il existe **trois espaces** distincts. Un calcul doit utiliser **un seul repère**. La conversion doit être **explicite** via `ScaleManager` ou les méthodes de la caméra.

### WorldDouble (sim units)
- **Ce que c'est :** Position absolue haute précision en unités simulation
- **Où :** `camera.doublepos`, `entity.doublepos`, `body.positionWorldDouble`
- **Utilisé pour :** LOD (SSE), culling backside/horizon, distances entre corps
- **Conversion depuis km :** `ScaleManager.toSimulationUnits(km)`

### Render-space (sim units)
- **Ce que c'est :** Espace relatif à la caméra — la caméra est toujours à (0, 0, 0)
- **Où :** `mesh.position`, `camera.position` (≈ 0), frustum planes, shadows
- **Utilisé pour :** Rendu GPU, frustum culling, post-processing, shadow maps
- **Conversion :** `camera.toRenderSpace(worldDouble, out)` ou `worldDouble - camera.doublepos`

### Planet-local (sim units)
- **Ce que c'est :** Origine au centre de la planète, axes alignés sur la rotation
- **Où :** Sorties des workers WASM (vertices, bounds), uniforms shader (`cameraPosition`, `uPatchCenter`, `lightDirection`)
- **Conversion vers WorldDouble :** `inversePivotMatrix * (worldDouble - planetCenter)`

### Règles d'application
- Ne jamais mélanger km et sim units dans un même calcul
- Toujours passer par `ScaleManager` pour toute conversion (jamais de constante magique)
- Les workers reçoivent des positions en Planet-local et retournent des meshes en Planet-local
- Le scheduler LOD (`LodScheduler`) lit uniquement `camera.doublepos` (WorldDouble)

---

## Fichiers critiques

| Fichier | Rôle |
|---------|------|
| `src/index.ts` | Bootstrap : initialise l'engine (WebGPU/WebGL2) et lance la scène |
| `src/app.ts` | `FloatingCameraScene.CreateScene()` — orchestre tous les systèmes |
| `src/core/camera/camera_manager.ts` | `OriginCamera` — doublepos, toRenderSpace, floating-origin |
| `src/core/scale/scale_manager.ts` | **Point unique** de conversion km ↔ sim (SCALE_FACTOR env) |
| `src/systems/lod/chunks/chunk_tree.ts` | Nœud CDLOD : split/merge/culling/worker request |
| `src/systems/lod/chunks/chunk_metrics.ts` | Calcul SSE et distance bounding sphere |
| `src/systems/lod/chunks/chunk_forge.ts` | Construction du mesh BabylonJS depuis les données worker |
| `src/systems/lod/lod_scheduler.ts` | Tick LOD avec budget frame et round-robin multi-planètes |
| `src/systems/lod/workers/worker_pool.ts` | Pool de Web Workers (hardwareConcurrency - 1) |
| `src/systems/lod/workers/terrain_mesh_worker.ts` | Entry point worker — protocole `mesh-kernel/1` |
| `src/systems/lod/workers/worker_protocol.ts` | Types du protocole init/build_chunk/chunk_result/cancel |
| `src/game_objects/planets/rocky_planet/terrains_shader.ts` | `TerrainShader` + `TerrainShadowContext` partagé |
| `src/game_world/stellar_system/stellar_catalog_loader.ts` | Charge `data.json` et crée `FloatingEntity` + CDLOD |
| `src/game_world/stellar_system/data.json` | Catalogue Sol (8 planètes) + Alpha Centauri (Proxima b) |
| `terrain/src/lib.rs` | `build_chunk()` WASM — génère positions/normals/uvs/indices |
| `src/assets/shaders/terrain/terrainVertexShader.glsl` | Déformation vertices, blending LOD |
| `src/assets/shaders/terrain/terrainFragmentShader.glsl` | Texturing diffuse+detail, ombres PCF3x3 |

---

## Systèmes clés

### Caméra à origine flottante (`OriginCamera`)
- `doublepos` : position absolue haute précision (WorldDouble)
- À chaque frame : accumulation du delta render → `doublepos`, reset render à l'origine
- Méthodes : `toRenderSpace(wd, out)`, `toWorldSpace(renderPos)`, `distanceToSim(wd)`
- `FloatingEntity` : entité dont `node.position` est recalculée en Render-space à chaque frame

### Système CDLOD (LodScheduler + ChunkTree)
- **Algorithme :** SSE (Screen-Space Error) — `ssePx = error * K / distance`
- **Seuils :** split si `ssePx > 5.0px`, merge si `ssePx < 4.0px` (hystérésis)
- **Structure :** 6 faces de cube (quad-sphère), subdivision récursive jusqu'à `maxLevel=12`
- **Résolution :** 96 vertices par côté (~9 409 verts/chunk)
- **Culling :** frustum (avec guard-band de prefetch) + backside/horizon
- **Scheduler :** `onBeforeRenderObservable` + budget `budgetMs` + round-robin multi-planètes
- **Paramètres configurables :** `maxConcurrent=8`, `maxStartsPerFrame=2`, `rescoreMs=100`, `budgetMs=30`

### Workers et WASM
- **Protocole :** `mesh-kernel/1` — `init → ready`, `build_chunk → chunk_result`, `cancel`
- **Pool :** `WorkerPool` avec `hardwareConcurrency - 1` threads
- **File de priorité :** min-heap par distance caméra, rescore périodique
- **Données retournées :** `Float32Array` (positions, normals, uvs) + `Uint32Array` (indices) + bounding sphere

### Pipeline de rendu
| Étape | Détail |
|-------|--------|
| Moteur | WebGPU avec fallback WebGL2 |
| Tone mapping | ACES |
| Bloom | BabylonJS built-in |
| Anti-aliasing | FXAA + MSAA 4x |
| Sharpen | Custom post-process |
| Étoiles | Ray-marching SDF (100 steps) |
| Atmosphère | Rayleigh + Mie scattering (post-process) |
| Ombres | ShadowGenerator 4096px, PCF3x3, portée dynamique (snapping stable) |

### Contrôles joueur (6DOF)
- **Souris :** Yaw/Pitch avec dead-zone (50px) et courbe de réponse
- **Clavier :** Z/S (avant/arrière), Q/D (strafe), R/F (monter/descendre), E/A (roll)
- **Modificateurs :** Shift (boost), Ctrl (frein)
- **Raccourcis debug :** L (LOD visualization), ² (BabylonJS Inspector), T (téléport Alpha Centauri)

---

## Conventions de code

### Formatage (Prettier)
```json
{ "semi": true, "trailingComma": "none", "singleQuote": true, "printWidth": 80 }
```

### Indentation (EditorConfig)
- TypeScript/JavaScript : **4 espaces**
- Autres fichiers : 2 espaces
- Fin de ligne : LF, charset UTF-8

### TypeScript
- Mode `strict: true` obligatoire
- Target `ESNext`, moduleResolution `Node`
- `noImplicitReturns: true`
- Pas d'imports `any` non justifiés

### Règles d'architecture
- Les dépendances vont toujours vers le bas (core ← systems ← game_objects ← game_world)
- `ScaleManager` est le **seul** endroit où des constantes de conversion km/sim sont définies
- Un calcul = un espace de coordonnées (pas de mélange implicite)
- Le thread principal ne doit pas générer de géométrie (déléguer aux workers)

---

## Tests

- **Framework :** Vitest (configuré dans `vitest.config.ts`)
- **Environnement :** Node (pas de DOM)
- **Couverture :** `src/**/*.{ts,tsx}` → rapport text + HTML
- **Fichier existant :** `src/core/scale/scale_manager.test.ts` (conversions d'unités)
- **Commandes :**
  ```bash
  npm test              # watch mode
  npm run coverage      # rapport dans /coverage/index.html
  ```

---

## État du projet et priorités

### Points forts (fonctionnels)
1. Floating-origin fonctionnel — précision maintenue à l'échelle 1:1
2. Génération terrain async (Workers + WASM) — main thread non bloqué
3. LodScheduler avec budget frame et round-robin — plus de boucle infinie
4. ScaleManager centralisé — conversion km ↔ sim units unifiée
5. Protocole worker typé (`mesh-kernel/1`) avec support d'annulation
6. Multi-systèmes stellaires (Sol, Alpha Centauri) depuis catalogue JSON
7. Pipeline post-processing complet (bloom, ACES, FXAA, atmosphère, ombres)
8. Compatibilité WebGPU avec fallback WebGL2

### Problèmes connus (ouverts)

| Priorité | Problème | Impact | Cible |
|----------|----------|--------|-------|
| **P2** | `ChunkTree` trop de responsabilités | Effets de bord lors de toute évolution | Découper en `ChunkNode` + `ChunkMeshService` + `ChunkVisibility` + `ChunkLodMetric` |
| **P3** | 1 material par chunk (potentiellement) | Draw calls élevés, overhead GPU | 1 material/planète partagé via `onBindObservable` |
| **P4** | Pas de déduplication worker | Gaspillage CPU, mêmes chunks demandés N fois | `dedup` par `chunkKey` + cancel de la queue |

### Roadmap technique (todo.txt)
- Pool d'objets pour les nodes (éviter dispose excessifs)
- Heightmap CPU via Web Worker dédié
- Génération GPU chunks via WebGPU compute shaders
- Streaming de textures depuis le cloud
- Projection UV équirectangulaire dans les shaders
- UV triplanaire dans les shaders
- Timeout de génération basé sur la vitesse caméra (éviter de charger au moindre mouvement)

---

## Déploiement

```bash
# 1. Build production
npm run build        # → /dist

# 2. Deploy GitHub Pages
npm run deploy       # utilise gh-pages -d dist

# URL de démo : https://bpodwinski.github.io/World42/
```

Les assets (skybox KTX2) sont chargés depuis `process.env.ASSETS_URL` — configurer dans `.env`.
