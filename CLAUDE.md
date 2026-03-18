# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
| Tests unitaires | Vitest | 4.0.5 |
| Tests E2E | Playwright (scripts custom) | — |
| Rendu GPU | WebGPU (fallback WebGL2) | — |
| Déploiement | GitHub Pages | — |

---

## Commandes de développement

```bash
# TypeScript
npm run serve       # Dev server → http://localhost:19000 (alias: npm run dev)
npm run build       # Build production → /dist
npm run deploy      # Deploy GitHub Pages (nécessite un build préalable)
npm test            # Vitest (watch mode)
npm run coverage    # Rapport couverture (text + HTML dans /coverage)

# Rust/WASM (exécuter dans le répertoire terrain/)
wasm-pack build --dev --target web --out-dir pkg     # Build WASM dev
wasm-pack build --release --target web --out-dir pkg  # Build WASM release

# Playwright (validation visuelle)
npm run pw:validate          # Smoke test bloquant (obligatoire pour agents AI)
npm run pw:open              # Ouvrir l'app dans un navigateur headed
npm run pw:world42:smoke     # Smoke check rapide
npm run pw:screenshot        # Capture d'écran
npm run pw:snapshot          # Capture accessibility snapshot
```

### Variables d'environnement

| Variable | Défaut | Usage |
|----------|--------|-------|
| `ASSETS_URL` | (dans `.env`) | URL de base pour les assets distants (skybox KTX2) |
| `SCALE_FACTOR` | (dans `.env`) | Facteur conversion km → sim units (lu par `ScaleManager`) |
| `HOST` | `localhost` | Hostname du dev server |
| `PORT` | `19000` | Port du dev server |
| `DEV_HOT` | `0` | `1` pour activer le HMR |
| `PW_URL` | `http://localhost:19000/` | URL cible Playwright |
| `PW_AUTO_SERVE` | `1` | Auto-démarre le dev server si l'URL est injoignable |
| `PW_HEADED` | `0` | `1` pour exécuter les tests en mode visible |
| `PW_SESSION` | — | Nom de session browser à réutiliser |

> **Important :** Créer un `.env` à la racine avec `ASSETS_URL=...` et `SCALE_FACTOR=...` avant de lancer le dev server. Ces variables sont injectées au build via `dotenv-webpack`.

---

## Architecture en couches

Les dépendances ne vont que dans un sens (vers le bas) : `core ← systems ← game_objects ← game_world`

```
src/
├── app/                # Orchestration scène (3 phases : bootstrap → LOD → runtime)
│   ├── bootstrap_scene.ts          # Crée la scène Babylon, charge les systèmes stellaires
│   ├── create_floating_camera_scene.ts  # Point d'entrée scène
│   ├── setup_lod_and_shadows.ts    # Initialise CDLOD + ombres
│   └── setup_runtime.ts            # Input, debug keys, boucle de rendu
│
├── core/               # Sous-systèmes moteur réutilisables (0 dépendance jeu)
│   ├── camera/         # OriginCamera (floating-origin), teleport
│   ├── control/        # MouseSteerControlManager (contrôles 6DOF vaisseau)
│   ├── gui/            # GuiManager, crosshair, HUD vitesse
│   ├── io/             # TextureManager (KTX2)
│   ├── lifecycle/      # DisposableRegistry
│   ├── render/         # EngineManager, PostProcessManager, star ray-marching
│   └── scale/          # ScaleManager — SEUL point de conversion km ↔ sim
│
├── systems/            # Systèmes réutilisables (dépendent de core)
│   └── lod/
│       ├── cbt/        # CBT (Concurrent Binary Tree) — nouveau système LOD
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
│       ├── data.json                       # Catalogue Sol + Alpha Centauri
│       ├── stellar_catalog_loader.ts       # Parse JSON + crée la scène
│       └── stellar_catalog_normalizer.ts   # Normalise les données du catalogue
│
├── assets/shaders/     # GLSL (terrain vertex/fragment, stars, atmosphere)
└── types/              # Déclarations TypeScript (.d.ts)

terrain/                # Crate Rust compilée en WASM
└── src/lib.rs          # build_chunk() — export WASM principal
```

### Initialisation (3 phases)

1. **`src/index.ts`** — Crée `EngineManager` (WebGPU/WebGL2), attache les listeners
2. **`src/app/bootstrap_scene.ts`** — Scène Babylon, chargement systèmes stellaires, spawn caméra
3. **`src/app/setup_lod_and_shadows.ts`** → **`src/app/setup_runtime.ts`** — LOD scheduler, ombres, puis input + boucle de rendu

---

## Espaces de coordonnées (règle d'or)

Il existe **trois espaces** distincts. Un calcul doit utiliser **un seul repère**. La conversion doit être **explicite** via `ScaleManager` ou les méthodes de la caméra.

### WorldDouble (sim units)
- Position absolue haute précision en unités simulation
- Où : `camera.doublepos`, `entity.doublepos`, `body.positionWorldDouble`
- Utilisé pour : LOD (SSE), culling backside/horizon, distances entre corps
- Conversion depuis km : `ScaleManager.toSimulationUnits(km)`

### Render-space (sim units)
- Espace relatif à la caméra — la caméra est toujours à (0, 0, 0)
- Où : `mesh.position`, `camera.position` (≈ 0), frustum planes, shadows
- Conversion : `camera.toRenderSpace(worldDouble, out)` ou `worldDouble - camera.doublepos`

### Planet-local (sim units)
- Origine au centre de la planète, axes alignés sur la rotation
- Où : sorties workers WASM (vertices, bounds), uniforms shader
- Conversion vers WorldDouble : `inversePivotMatrix * (worldDouble - planetCenter)`

### Règles d'application
- Ne jamais mélanger km et sim units dans un même calcul
- Toujours passer par `ScaleManager` pour toute conversion (jamais de constante magique)
- Les workers reçoivent des positions en Planet-local et retournent des meshes en Planet-local
- Le scheduler LOD (`LodScheduler`) lit uniquement `camera.doublepos` (WorldDouble)

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
- **Paramètres :** `maxConcurrent=8`, `maxStartsPerFrame=2`, `rescoreMs=100`, `budgetMs=30`

### CBT (Concurrent Binary Tree) — nouveau système LOD
- Module dans `src/systems/lod/cbt/` — travail en cours
- `cbt_state.ts` : état du binary tree, `cbt_classify.ts` : classification split/merge
- `cbt_emit.ts` : émission des triangles, `cbt_scheduler.ts` : orchestration
- Supporte `maxMergesPerFrame` et leaf merging

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

### Nommage fichiers
- snake_case pour les modules (ex: `lod_scheduler.ts`)
- PascalCase uniquement pour les déclarations de types quand déjà établi

### Commits
- Style Conventional Commits : `feat:`, `fix:`, `docs:`, `refactor:`, etc.
- Messages concis, impératif

### Règles d'architecture
- Les dépendances vont toujours vers le bas (core ← systems ← game_objects ← game_world)
- `ScaleManager` est le **seul** endroit où des constantes de conversion km/sim sont définies
- Un calcul = un espace de coordonnées (pas de mélange implicite)
- Le thread principal ne doit pas générer de géométrie (déléguer aux workers)

---

## Tests

- **Framework :** Vitest (configuré dans `vitest.config.ts`), globals activés
- **Environnement :** Node (pas de DOM)
- **Couverture :** `src/**/*.{ts,tsx}` → rapport text + HTML dans `/coverage`
- **Convention :** tests colocalisés avec les sources (`*.test.ts` à côté du fichier testé)
- **Commandes :**
  ```bash
  npm test              # watch mode
  npm run coverage      # rapport dans /coverage/index.html
  ```

### Validation Playwright (obligatoire pour agents AI)
- Toute modification doit passer `npm run pw:validate` avant d'être considérée terminée
- Validation : smoke visuel bloquant (ouverture app, capture snapshot + screenshot)
- Artefacts exportés dans `output/playwright/<runId>/`
- Si la validation échoue, la tâche n'est pas validée

---

## Problèmes connus

| Priorité | Problème | Cible |
|----------|----------|-------|
| **P2** | `ChunkTree` trop de responsabilités | Découper en `ChunkNode` + `ChunkMeshService` + `ChunkVisibility` + `ChunkLodMetric` |
| **P3** | 1 material par chunk (potentiellement) | 1 material/planète partagé via `onBindObservable` |
| **P4** | Pas de déduplication worker | `dedup` par `chunkKey` + cancel de la queue |

---

## Roadmap technique
- Pool d'objets pour les nodes (éviter dispose excessifs)
- Heightmap CPU via Web Worker dédié
- Génération GPU chunks via WebGPU compute shaders
- Streaming de textures depuis le cloud
- UV triplanaire / équirectangulaire dans les shaders
- Timeout de génération basé sur la vitesse caméra
