# Analyse complète du projet World42

## Contexte

World42 est un **moteur de rendu planétaire temps réel** en 1:1, construit avec **BabylonJS 8.51.1**, **TypeScript** et un générateur de terrain en **Rust/WASM**. Le projet implémente un système de LOD (Level of Detail) par quadtree sur une quad-sphère, avec une caméra à origine flottante pour maintenir la précision à des échelles interplanétaires.

**Version :** 0.0.5
**Demo live :** https://bpodwinski.github.io/World42/
**Bundler :** Rspack (alternative moderne à Webpack)
**Tests :** Vitest

---

## 1. Architecture globale

Le projet suit une architecture en couches bien définie :

```
src/
├── core/              # Sous-systèmes moteur (indépendants du jeu)
│   ├── camera/        # OriginCamera (origine flottante, haute précision)
│   ├── render/        # EngineManager, PostProcess, ray-marching étoiles
│   ├── control/       # Contrôles 6DOF (souris + clavier)
│   ├── gui/           # GuiManager + composants (crosshair, HUD vitesse)
│   ├── io/            # TextureManager (chargement KTX2)
│   └── scale/         # ScaleManager (conversions km ↔ unités simulation)
│
├── systems/           # Systèmes réutilisables
│   └── lod/           # Scheduler LOD, quadtree, workers
│       ├── chunks/    # ChunkTree, forge, culling, métriques SSE
│       └── workers/   # Pool de workers, protocole WASM, file de priorité
│
├── game_objects/      # Entités spécifiques au domaine
│   └── planets/rocky_planet/  # Terrain, shader terrain, scattering atmosphérique
│
├── game_world/        # Logique de jeu
│   └── stellar_system/  # Catalogue stellaire JSON, loader multi-systèmes
│
├── assets/shaders/    # Fichiers GLSL (terrain, étoiles, atmosphère)
├── types/             # Déclarations TypeScript
└── utils/             # Utilitaires divers
```

**Composant Rust/WASM** (`/terrain/`) : Générateur de terrain procédural utilisant le bruit de Perlin (`noise 0.9`), compilé en WebAssembly via `wasm-bindgen`.

---

## 2. Systèmes techniques clés

### 2.1 Caméra à origine flottante (`core/camera/camera_manager.ts`)

| Aspect | Détail |
|--------|--------|
| **Problème résolu** | Perte de précision float32 aux échelles planétaires |
| **Mécanisme** | Position render-space toujours à (0,0,0), position réelle en `doublepos` (Vector3 haute précision) |
| **Par frame** | Accumulation du delta render → `doublepos`, puis reset render à l'origine |
| **Propriétés** | `doublepos`, `doubletgt`, `velocitySim`, `speedSim` |
| **Conversions** | `toRenderSpace(worldSim)`, `toWorldSpace(renderPos)`, `distanceToKm()` |

### 2.2 Système LOD / Quadtree CDLOD

**Fichiers principaux :** `lod_scheduler.ts`, `chunk_tree.ts`, `chunk_forge.ts`, `chunk_metrics.ts`

- **Algorithme :** Subdivision quadtree basée sur le Screen-Space Error (SSE)
- **Structure :** 6 faces de cube (quad-sphère), subdivision récursive
- **Seuils :** `splitTh=5.0px`, `mergeTh=4.0px` (hystérésis pour éviter le scintillement)
- **Résolution :** 96 vertices par côté (~9 409 vertices/chunk)
- **Niveaux LOD :** 0 à 12 (configurable)

**Pipeline de décision par frame :**
1. Culling frustum (avec guard-band de prefetch)
2. Culling backside/horizon (sphère vs direction de vue)
3. Calcul SSE : `ssePx = error * K / distance`
4. Split si `ssePx > splitTh` → 4 enfants créés en parallèle
5. Merge si `ssePx < mergeTh` → enfants supprimés, parent réaffiché

**Scheduler (`lod_scheduler.ts`) :**
- File de priorité min-heap (par distance caméra)
- Budget par frame : `maxConcurrent=8`, `maxStartsPerFrame=2`
- Rescore périodique toutes les 200ms

### 2.3 Workers et WASM (`systems/lod/workers/`)

- **Protocole :** `mesh-kernel/1` (init → ready, build_chunk → chunk_result, cancel)
- **Pool :** `WorkerPool` avec `hardwareConcurrency - 1` threads
- **Pipeline :** Job enqueue → worker disponible → WASM `build_chunk()` → mesh data retournée
- **Données mesh :** `Float32Array` (positions, normals, uvs) + `Uint32Array` (indices)
- **Terrain Rust :** Bruit de Perlin avec paramètres (seed, octaves, fréquence, amplitude, lacunarité, persistance)

### 2.4 Pipeline de rendu

| Composant | Implémentation | Fichier |
|-----------|---------------|---------|
| **Moteur** | WebGPU (fallback WebGL2) | `engine_manager.ts` |
| **Post-processing** | Tone mapping ACES, Bloom, FXAA, Sharpen, MSAA 4x | `postprocess_manager.ts` |
| **Étoiles** | Ray-marching SDF sphère (100 pas) | `star_raymarch_postprocess.ts` |
| **Atmosphère** | Rayleigh + Mie scattering | `atmospheric-ccattering-postprocess.ts` |
| **Ombres terrain** | ShadowGenerator 4096px, PCF3x3, portée dynamique | `app.ts`, `terrainFragmentShader.glsl` |
| **Terrain shader** | Diffuse + detail KTX2, éclairage directionnel, debug LOD | `terrains_shader.ts` |

### 2.5 Contrôles joueur (`core/control/mouse_steer_control_manager.ts`)

Contrôle vaisseau spatial 6DOF :
- **Souris :** Yaw/Pitch avec dead-zone (50px) et courbe de réponse
- **Clavier :** Z/S (avancer/reculer), Q/D (strafe), R/F (monter/descendre), E/A (roll)
- **Modificateurs :** Shift (boost), Ctrl (frein)
- **Physique :** Accélération → vélocité → position avec amortissement exponentiel

---

## 3. Shaders GLSL (5 fichiers)

| Shader | Fichier | Rôle |
|--------|---------|------|
| Terrain vertex | `terrain/terrainVertexShader.glsl` | Déformation vertices, normales, blending LOD |
| Terrain fragment | `terrain/terrainFragmentShader.glsl` | Texturing diffuse+detail, éclairage, ombres PCF3x3 |
| Terrain debug LOD | `terrain/_terrainDebugLOD.glsl` | Visualisation colorée des niveaux LOD |
| Star ray-march | `stars/starRayMarchingFragmentShader.glsl` | Halo lumineux étoiles (SDF) |
| Atmospheric scattering | `atmosphericScatteringFragmentShader.glsl` | Diffusion Rayleigh + Mie volumétrique |

---

## 4. Données et catalogue stellaire

**Fichier :** `src/game_world/stellar_system/data.json`

- Systèmes : Sol, Alpha Centauri
- Corps : planètes, lunes, étoiles avec propriétés physiques
- Format : `{ type, position_km, diameter_km, rotation_period_days, star? }`
- Chargement dynamique via `stellar_catalog_loader.ts`

---

## 5. Dépendances

### Production
| Package | Version | Rôle |
|---------|---------|------|
| `@babylonjs/core` | ^8.51.1 | Moteur 3D principal |
| `@babylonjs/gui` | ^8.51.1 | Interface utilisateur |
| `@babylonjs/inspector` | ^8.51.1 | Debug inspector |
| `@babylonjs/ktx2decoder` | ^8.51.1 | Décodage textures KTX2 |
| `@babylonjs/loaders` | ^8.51.1 | Chargement de modèles |
| `@babylonjs/materials` | ^8.51.1 | Matériaux intégrés |
| `dotenv` | ^17.2.3 | Variables d'environnement |

### Rust/WASM (terrain/)
| Crate | Version | Rôle |
|-------|---------|------|
| `wasm-bindgen` | 0.2 | Bridge WASM/JS |
| `noise` | 0.9 | Bruit de Perlin/Simplex |
| `js-sys` | 0.3 | Bindings JavaScript |

---

## 6. Tests et qualité

| Aspect | Statut |
|--------|--------|
| **Framework** | Vitest (configuré dans `vitest.config.ts`) |
| **Tests existants** | `scale_manager.test.ts` (conversions d'unités) |
| **Couverture** | Configurée (text + HTML) mais couverture minimale |
| **Linting** | Prettier configuré (single quotes, semicolons, 80 cols) |
| **CI/CD** | Aucun pipeline configuré |
| **Docker** | Non présent |

---

## 7. Points forts

1. **Architecture en couches** bien séparée (core → systems → game_objects → game_world)
2. **Origine flottante** fonctionnelle permettant le rendu à l'échelle 1:1
3. **Génération asynchrone** des meshes via Web Workers + WASM
4. **Système LOD** avec métriques SSE, culling frustum et backside
5. **Protocole worker typé** (`mesh-kernel/1`) avec support d'annulation
6. **Support multi-systèmes stellaires** (Sol, Alpha Centauri)
7. **Pipeline post-processing complet** (bloom, tone mapping, FXAA, ombres dynamiques)
8. **Compatibilité WebGPU** avec fallback WebGL2

---

## 8. Points d'amélioration identifiés

### Architecturaux

| Priorité | Problème | Recommandation |
|----------|----------|----------------|
| **P0** | Incohérences d'unités (km vs sim) | Unifier les conversions, verrouiller WorldDouble vs Render vs Local |
| **P1** | Boucle LOD non budgétisée | Remplacer la boucle while par observable + budget frame |
| **P2** | `ChunkTree` a trop de responsabilités | Découper en ChunkNode + ChunkMeshService + ChunkVisibility |
| **P3** | 1 matériau par chunk (coûteux) | 1 matériau/planète avec uniforms `onBind` |
| **P4** | Pas de déduplication worker | Ajouter dédup + file d'annulation |

### Développement

| Aspect | Observation |
|--------|-------------|
| **Couverture tests** | Très faible - seul `ScaleManager` est testé |
| **CI/CD** | Aucun pipeline automatisé |
| **Documentation** | README basique, pas de JSDoc systématique |
| **Typo dans fichier** | `atmospheric-ccattering-postprocess.ts` (double 'c') |
| **Error handling** | Minimal dans les workers et le chargement d'assets |

### Roadmap suggérée

1. Pool d'objets pour les nodes (éviter les dispose excessifs)
2. Heightmap CPU via Web Worker
3. Génération GPU chunks via WebGPU compute shaders
4. Streaming de textures depuis le cloud
5. Projection UV équirectangulaire dans les shaders
6. UV triplanaire dans les shaders
7. Génération de chunks basée sur la vitesse caméra + timeout

---

## 9. Résumé

| Caractéristique | Valeur |
|-----------------|--------|
| **Type** | Moteur de rendu planétaire client-side |
| **Langage** | TypeScript strict + Rust (WASM) |
| **Moteur 3D** | BabylonJS 8.51.1 |
| **Bundler** | Rspack |
| **Rendu** | WebGPU / WebGL2 |
| **Serveur** | Aucun (SPA statique) |
| **Réseau/Multijoueur** | Non implémenté |
| **Base de données** | Aucune (catalogue JSON) |
| **Tests** | Minimaux (1 fichier de test) |
| **CI/CD** | Non configuré |
| **Déploiement** | GitHub Pages |
| **Fichiers source** | ~42 fichiers TypeScript + 5 GLSL + 1 crate Rust |
