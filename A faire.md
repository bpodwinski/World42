## Bilan global du projet World42 (CDLOD planète 1:1)

### Repères de référence

Avant toute logique de **culling/LOD/bounds**, il faut fixer et appliquer systématiquement les repères suivants :

* **WorldDouble** : `camera.doublepos`, `entity.doublepos` (vérité des positions, distances énormes, SSE, backside/horizon).
* **Render** (floating origin) : `camera.position ≈ 0`, `mesh.position` (rendu GPU, collisions, postprocess).
* **Planet-local** : sortie worker (géométrie et éventuellement `boundsInfo.centerLocal`), convertie ensuite vers WorldDouble/Render explicitement.

Règle d’or : un calcul utilise **un seul repère** ; conversion explicite si nécessaire.

---

## 1) Ce que ton pipeline fait aujourd’hui (résumé)

1. **Données** : JSON système solaire + logique `PlanetData`/normalisation.
2. **Spawn scène** : création des `TransformNode`/meshes Babylon + création de `FloatingEntity` (mais pas toujours parentage cohérent).
3. **Caméra** : `OriginCamera` intègre les deltas Render → WorldDouble et recentre la scène ; met à jour les `FloatingEntity`.
4. **CDLOD** : `ChunkTree` décide split/merge, fait culling, déclenche worker, construit mesh/material, gère enfants/parent.
5. **Workers** : pool + priorité, worker wasm, protocole résultat, parfois cancel rudimentaire.
6. **Rendu** : shader terrain + postprocess atmosphère + pipeline.

---

## 2) Points forts (ce qui est déjà bien engagé)

* **Floating origin fonctionnel** (la mécanique “deltas Render → doublepos” est une bonne base).
* **Génération terrain async via Workers** : bon choix pour éviter de bloquer le thread principal.
* **Métriques existantes** (SSE, distance bounding sphere, frustum helpers) : tu as les briques nécessaires pour un LOD stable.
* **Protocole worker** déjà structuré (`init/build/cancel`) et capacité à renvoyer des bounds (`boundsInfo`) : très utile pour culling.

---

## 3) Problèmes structurants (ce qui te freine)

### A) Séparation des responsabilités insuffisante

* `ChunkTree` fait : modèle quadtree + LOD + culling + scheduling + build mesh Babylon + debug.
* `solar_system_loader.ts` mélange parsing JSON + création scène + création CDLOD + boucle LOD.
* `TerrainShader` dépend de `PlanetData` et fige des uniforms dynamiques à la création.

Impact : chaque évolution (perf, culling, shaders, workers) crée des effets de bord.

### B) Incohérence d’unités et de repères

* `PlanetData` convertit via `ScaleManager`, mais le loader place aussi des positions/rayons en “km” sans conversion uniforme.
* Certaines valeurs (ex: centres, directions lumière) sont calculées sans garantir même repère/échelle.

Impact : culling instable, SSE incohérent, artefacts visuels, bugs “impossibles” à tracer.

### C) Scheduling LOD non “pro”

* Boucle `while(true)` + `requestAnimationFrame` qui parcourt tous les chunks.
* `updateLOD()` peut faire des `await Promise.all` récursifs.

Impact : spikes CPU, latence, oscillations, pas de budget, pas d’annulation/dépriorisation propre.

### D) Worker system incomplet (annulation/dedup)

* `cancel` côté worker annule surtout le job courant, mais pas les jobs en queue ni la coalescence.
* Pas de “dedup” : un même chunk peut être demandé plusieurs fois.

Impact : gaspillage CPU, pression mémoire, latence inutile.

### E) Rendu terrain : coûts et couplage

* Risque de recréer textures/materials trop souvent.
* Uniforms dynamiques (`cameraPosition`, etc.) posés au moment de création du material.
* `lodLevel` par chunk pousse vers “1 material par chunk” (coûteux).

Impact : draw calls élevés, CPU/GPU overhead, gestion de ressources compliquée.

### F) Debug / UI mêlés au core

* `WorkerPool` peut écrire dans le DOM.
* Toggle debug via statique (`ChunkTree.debugLODEnabled`) depuis `index.ts`.

Impact : dépendances croisées et rigidité.

---

## 4) Risques actuels (si tu continues sans refacto)

* **LOD instable** (split/merge qui “pompe”), surtout si tick order et repères ne sont pas stricts.
* **Pics de frame time** (recursion async + precompute massive + pas de budget).
* **Fuite mémoire / surcharge** (textures/materials, jobs redondants, meshes non disposés au bon moment).
* **Difficulté à ajouter des features** (cratères, biomes, batching, transitions anti-cracks) sans casser autre chose.

---

## 5) Ce que serait une architecture “pro” pour ton projet (cible)

### Couches (sens unique des dépendances)

1. **Data** : parse/normalize JSON (zéro Babylon).
2. **Scale/Sim** : conversion unique via `ScaleManager` → positions/rayons en **WorldDouble**.
3. **Scene Factory** : crée `FloatingEntity` + attache les nodes Babylon sous `ent.node` (Render).
4. **LOD System** :

   * `ChunkNode` (modèle pur)
   * `ChunkBounds` (WorldDouble)
   * `ChunkVisibility` (WorldDouble → conversion Render pour frustum)
   * `ChunkLodMetric` (WorldDouble)
   * `ChunkTransitions` (parent/enfants, anti-trous)
   * `LodController.tick(dt)` (budget, priorités, annulation)
5. **Mesh Kernel** :

   * `WorkerPool` (générique, sans UI)
   * `MeshKernelClient` (protocole, cancel, dedup)
   * `ChunkMeshBuilder` (meshData → Babylon mesh, metadata)
6. **Render Systems** :

   * `TerrainMaterialService` (1 material partagé, uniforms via onBind)
   * `AtmosphereSystem` (postprocess, matrices toRef)

### Tick order recommandé

1. Inputs (Render)
2. `OriginCamera` intègre → met à jour `doublepos` + entités flottantes
3. `LodController.tick()` lit `camera.doublepos` et déclenche/annule des jobs
4. Rendu

---

## 6) Plan d’action pragmatique (par priorité)

### Priorité 0 — Stabiliser repères + unités (bloquant)

* Unifier la conversion km → simulation units à **un seul endroit**.
* Vérité des positions planètes : `FloatingEntity.doublepos` (WorldDouble).
* Tous les meshes/nodes Babylon des corps parentés à `ent.node`, et en Render-space local.

### Priorité 1 — Sortir le LOD du “while(true)”

* Supprimer la boucle infinie, brancher `LodController.tick()` sur un observable Babylon **après** l’intégration de la caméra.
* Ajouter un budget simple : max splits / max jobs par frame.

### Priorité 2 — Découpler `ChunkTree`

* Transformer `ChunkTree` en `ChunkNode` (données + enfants + état).
* Déplacer :

  * worker requests → `ChunkMeshService`
  * build mesh → `ChunkMeshBuilder`
  * culling → `ChunkVisibility`
  * SSE → `ChunkLodMetric`
  * swap parent/enfants → `ChunkTransitions`

### Priorité 3 — Rendu terrain “1 material / planète”

* `TerrainMaterialService` :

  * textures chargées 1 fois
  * `onBindObservable` lit `mesh.metadata.lodLevel` et pose les uniforms
* Lumière : service séparé (pas de dépendance `PlanetData` dans le shader).

### Priorité 4 — Worker “pro”

* `MeshKernelClient` :

  * dedup par `chunkKey`
  * cancel queue + cancel in-flight
  * typage strict du protocole (alias `Face/Bounds`)

---

## 7) Bilan final en une phrase

Tu as une base technique solide (floating origin + workers + CDLOD), mais l’architecture actuelle est encore “prototype” : responsabilités fusionnées, unités/repères pas verrouillés, scheduling LOD non budgété et rendu terrain trop couplé. En séparant en services (LOD / MeshKernel / Render) et en imposant strictement WorldDouble vs Render vs Local, tu obtiens une architecture nettement plus simple, testable et évolutive, sans changer l’algorithme CDLOD lui-même.
