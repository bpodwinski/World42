import {
    Engine,
    Scene,
    Vector3,
    MeshBuilder,
    Texture,
    StandardMaterial,
    CubeTexture,
    WebGPUEngine,
    Viewport,
    UniversalCamera
} from '@babylonjs/core';
import '@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader';
import '@babylonjs/core/Debug/debugLayer';
import '@babylonjs/inspector';

import { PostProcess } from './core/render/postprocess_manager';
import { OriginCamera } from './core/camera/camera_manager';
import { MouseSteerControlManager } from './core/control/mouse_steer_control_manager';
import { GuiManager } from './core/gui/gui_manager';
import planetsJson from './game_world/stellar_system/data.json';
import { teleportToEntity } from './core/camera/teleport_entity';
import { ScaleManager } from './core/scale/scale_manager';
import { createCDLODForSystem, listStellarSystems, loadStellarSystemFromCatalog, PlanetCDLOD } from './game_world/stellar_system/stellar_catalog_loader';
import { LodScheduler } from './systems/lod/lod_scheduler';
import { attachStarRayMarchingPostProcess, type StarGlowSource } from "./core/render/star_raymarch_postprocess";
import { DirectionalLight, ShadowGenerator, Matrix, Vector2 } from "@babylonjs/core";
import { TerrainShader, type TerrainShadowContext } from "./game_objects/planets/rocky_planet/terrains_shader";

/**
 * Coordinate space conventions used throughout:
 *
 * - **WorldDouble** (sim units): High-precision absolute positions stored in `doublepos`.
 *   Converted from km via `ScaleManager.toSimulationUnits(km)`. Used for LOD, culling, distances.
 *
 * - **Render-space** (sim units): Floating-origin relative to camera. camera.position is always (0,0,0).
 *   `renderPos = worldDouble - camera.doublepos`. Used for GPU rendering, frustum planes, shadows.
 *
 * - **Planet-local** (sim units): Origin at planet center, axes follow planet rotation.
 *   Worker mesh vertices, shader uniforms (cameraPosition, uPatchCenter, lightDirection).
 *   Conversion: `local = inversePivotMatrix * (worldDouble - planetCenter)`.
 */
export class FloatingCameraScene {
    public static async CreateScene(
        engine: Engine | WebGPUEngine,
        canvas: HTMLCanvasElement
    ): Promise<Scene> {
        const scene = new Scene(engine);
        scene.clearColor.set(0, 0, 0, 1);
        scene.collisionsEnabled = true;

        const systemIds = listStellarSystems(planetsJson);

        // Charge tout
        const loadedSystemsArr = await Promise.all(
            systemIds.map((id) => loadStellarSystemFromCatalog(scene, planetsJson, id))
        );
        const loadedSystems = new Map(loadedSystemsArr.map((s) => [s.systemId, s]));

        // Choisit le système actif (Sol si présent, sinon le 1er)
        const activeSystem =
            loadedSystems.get("Sol") ?? loadedSystemsArr[0];

        const systemBodies = activeSystem.bodies;

        // Choisit un corps de spawn (Mercury si présent, sinon 1re planète non-star)
        const body =
            systemBodies.get("Mercury") ??
            Array.from(systemBodies.values()).find((b) => b.bodyType !== "star");

        if (!body) {
            throw new Error("Aucun corps (planète) trouvé dans le système actif.");
        }

        scene.textures.forEach((texture) => {
            texture.anisotropicFilteringLevel = 16;
        });

        // GUI
        const gui = new GuiManager(scene);
        gui.setMouseCrosshairVisible(true);

        // -------------------------
        // IMPORTANT (P0):
        // node.position est en Render-space (souvent 0),
        // la vraie position est body.positionWorldDouble (WorldDouble).
        // -------------------------
        const planetTargetWorldDouble = body.positionWorldDouble.clone();
        // Spawn camera slightly above the surface (52% of radius above center)
        planetTargetWorldDouble.y += body.radiusSim * 1.04;

        const camera = new OriginCamera('camera_player', planetTargetWorldDouble, scene);
        camera.debugMode = true;
        camera.minZ = 0.001;
        camera.maxZ = 1_000_000;
        camera.fov = 1.2;
        camera.applyGravity = false;
        camera.inertia = 0;
        camera.inputs.clear();
        camera.checkCollisions = false;

        // Optionnel mais utile: viser la planète au spawn
        const tmpTargetRender = new Vector3();
        camera.toRenderSpace(body.positionWorldDouble, tmpTargetRender);
        camera.setTarget(tmpTargetRender);

        // Collider mesh invisible (Render-space)
        const camCollider = MeshBuilder.CreateSphere("camCollider", { segments: 64, diameter: 0.05 }, scene);
        camCollider.isVisible = false;
        camCollider.isPickable = false;
        camCollider.checkCollisions = true;
        camCollider.position.set(0, 0, 0);
        camCollider.ellipsoid = new Vector3(0.05, 0.05, 0.05);
        camCollider.ellipsoidOffset = new Vector3(0.05, 0.05, 0.05);

        // Reset collider après l'intégration floating-origin
        scene.onAfterActiveMeshesEvaluationObservable.add(() => {
            camCollider.position.set(0, 0, 0);
        });

        const control = new MouseSteerControlManager(camera, scene, canvas, camCollider, {});
        control.gui = gui;

        // Debug camera
        const debugCam = new UniversalCamera('debugCam', Vector3.Zero(), scene);
        debugCam.minZ = camera.minZ;
        debugCam.maxZ = camera.maxZ;
        debugCam.fov = camera.fov;
        debugCam.inputs.clear();

        // WorldDouble debug cam
        // Debug camera: 3 radii behind along Z (sim units)
        let debugDoublePos = camera.doublepos.clone().add(new Vector3(0, 0, body.radiusSim * 3.0));
        let debugDoubleTgt = body.positionWorldDouble.clone();

        camera.viewport = new Viewport(0, 0, 1, 1);
        debugCam.viewport = new Viewport(0.5, 0.5, 0.5, 0.5);
        scene.activeCameras = [camera, debugCam];

        const tmpTgtRender = new Vector3();
        scene.onBeforeRenderObservable.add(() => {
            camera.toRenderSpace(debugDoublePos, debugCam.position);
            camera.toRenderSpace(debugDoubleTgt, tmpTgtRender);
            debugCam.setTarget(tmpTgtRender);
        });

        const keys = new Set<string>();
        window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
        window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

        scene.onBeforeRenderObservable.add(() => {
            const dt = engine.getDeltaTime() / 1000;
            // Debug camera speed: 40% of radius per second (sim units/s)
            const speed = body.radiusSim * 0.4 * dt;

            const fwd = debugCam.getDirection(Vector3.Forward());
            const right = debugCam.getDirection(Vector3.Right());
            const up = debugCam.getDirection(Vector3.Up());

            if (keys.has('i')) debugDoublePos.addInPlace(fwd.scale(speed));
            if (keys.has('k')) debugDoublePos.addInPlace(fwd.scale(-speed));
            if (keys.has('l')) debugDoublePos.addInPlace(right.scale(speed));
            if (keys.has('j')) debugDoublePos.addInPlace(right.scale(-speed));
            if (keys.has('u')) debugDoublePos.addInPlace(up.scale(speed));
            if (keys.has('o')) debugDoublePos.addInPlace(up.scale(-speed));
        });

        const mergedCDLOD = new Map<string, PlanetCDLOD>();

        for (const sys of loadedSystems.values()) {
            const cdlod = createCDLODForSystem(scene, camera, sys, {
                maxLevel: 12,
                resolution: 96,
            });

            for (const [name, planet] of cdlod.entries()) {
                mergedCDLOD.set(`${sys.systemId}:${name}`, planet);
            }
        }

        const roots = Array.from(mergedCDLOD.values()).flatMap(p => p.chunks);

        const lod = new LodScheduler(scene, camera, roots, {
            maxConcurrent: 8,
            maxStartsPerFrame: 2,
            rescoreMs: 100,
            applyDebugEveryFrame: true,
            // P1: limit LOD update CPU time to 4 ms per frame to avoid render stalls.
            budgetMs: 30,
        });

        lod.start();

        // --------------------
        // Terrain shadows (1 ShadowGenerator shared around camera)
        // All distances below are in **simulation units** (= Render-space, since camera is at origin).
        // --------------------
        const SHADOW_MAP_SIZE = 4096;              // shadow map resolution (pixels)
        const MIN_SHADOW_RANGE = 2500;             // ortho half-size min, sim units (near ground, improves local texel density)
        const MAX_SHADOW_RANGE = 50000;            // ortho half-size max, sim units (high altitude)
        const RANGE_LERP = 0.12;                   // smoothing factor 0..1 (lower = smoother)
        const DEPTH_HALF_MULT = 2.0;               // half depth extent = shadowRange * DEPTH_HALF_MULT (sim units)
        const LIGHT_DIST_MULT = 2.5;               // light distance = shadowRange * LIGHT_DIST_MULT + LIGHT_DIST_ADD
        const LIGHT_DIST_ADD = 5000;               // fixed margin, sim units

        let shadowRange = 12000;                   // smoothed runtime value, sim units

        const shadowLight = new DirectionalLight("terrainShadowLight", new Vector3(0, -1, 0), scene);
        shadowLight.intensity = 0; // ombres uniquement

        const shadowGen = new ShadowGenerator(SHADOW_MAP_SIZE, shadowLight, true);

        // Biais côté génération de shadow map (anti-acne)
        shadowGen.bias = 0.0015;
        shadowGen.normalBias = 0.6;

        // Contexte partagé lu par TerrainShader.onBindObservable
        const shadowCtx: TerrainShadowContext = {
            shadowGen,
            shadowMap: shadowGen.getShadowMapForRendering()!, // IMPORTANT WebGPU
            lightMatrix: new Matrix(),
            texelSize: new Vector2(1 / SHADOW_MAP_SIZE, 1 / SHADOW_MAP_SIZE),
            bias: 0.00025,     // bias shader constant
            normalBias: 0.0020, // bias dépendant de l'angle (réduit fortement le shadow acne)
            darkness: 1.0,
            reverseDepth: (engine as any).useReverseDepthBuffer ? 1 : 0,
        };

        TerrainShader.setTerrainShadowContext(scene, shadowCtx);

        // --- Active planet selection (closest to camera in WorldDouble) ---
        let activePlanet: PlanetCDLOD | null = null;
        let lastPickMs = 0;
        const PICK_MS = 250;

        function pickActivePlanetNow() {
            let best: PlanetCDLOD | null = null;
            let bestD = Number.POSITIVE_INFINITY;
            for (const p of mergedCDLOD.values()) {
                const d = camera.distanceToSim(p.entity.doublepos);
                if (d < bestD) { bestD = d; best = p; }
            }
            activePlanet = best;
        }
        pickActivePlanetNow();

        // temporaires
        const tmpStarRender = new Vector3();
        const tmpPlanetRender = new Vector3();
        const lightDir = new Vector3();
        const camPosRender = new Vector3();
        const lightRight = new Vector3();
        const lightUp = new Vector3();
        const lightView = new Matrix();
        const centerLS = new Vector3();

        scene.onBeforeRenderObservable.add(() => {
            // (A) choisir planète active (throttle)
            const now = performance.now();
            if (now - lastPickMs > PICK_MS) {
                pickActivePlanetNow();
                lastPickMs = now;
            }
            if (!activePlanet) return;

            const starPosWorldDouble = activePlanet.chunks[0]?.starPosWorldDouble;
            if (!starPosWorldDouble) return;

            // (B) Render-space conversion
            const camWD = camera.doublepos;

            tmpStarRender.set(
                starPosWorldDouble.x - camWD.x,
                starPosWorldDouble.y - camWD.y,
                starPosWorldDouble.z - camWD.z
            );

            const planetCenterWD = activePlanet.entity.doublepos;
            tmpPlanetRender.set(
                planetCenterWD.x - camWD.x,
                planetCenterWD.y - camWD.y,
                planetCenterWD.z - camWD.z
            );

            // (C) Direction rayons: étoile -> planète (Render-space)
            lightDir.copyFrom(tmpPlanetRender).subtractInPlace(tmpStarRender);
            if (lightDir.lengthSquared() < 1e-12) return;
            lightDir.normalize();
            shadowLight.direction.copyFrom(lightDir);

            // (D) Centre autour caméra (Render-space)
            camPosRender.copyFrom(camera.position);

            // (E) shadowRange dynamique (altitude -> range)
            const distToCenter = camera.distanceToSim(planetCenterWD);
            // Altitude above surface in sim units
            const altitude = Math.max(0, distToCenter - activePlanet.radiusSim);
            // targetRange in sim units: grows with altitude (2x altitude + 2000 base)
            const targetRange = Math.min(
                MAX_SHADOW_RANGE,
                Math.max(MIN_SHADOW_RANGE, altitude * 1.25 + 1500.0)
            );

            // Quantize to power-of-2 steps (sim units) to avoid "resolution pumping" near ground
            function quantizeRange(r: number) {
                const base = 500; // sim units
                const q = base * Math.pow(2, Math.round(Math.log(r / base) / Math.log(2)));
                return Math.min(MAX_SHADOW_RANGE, Math.max(MIN_SHADOW_RANGE, q));
            }

            const targetQ = quantizeRange(targetRange);
            shadowRange += (targetQ - shadowRange) * RANGE_LERP;

            // LIGHT_DISTANCE lié au range (réduit énormément les banding/acne)
            const lightDistance = shadowRange * LIGHT_DIST_MULT + LIGHT_DIST_ADD;

            // (F) Ortho autour caméra
            shadowLight.orthoLeft = -shadowRange;
            shadowLight.orthoRight = shadowRange;
            shadowLight.orthoTop = shadowRange;
            shadowLight.orthoBottom = -shadowRange;

            // (G) Profondeur serrée (half extent)
            const depthHalf = shadowRange * DEPTH_HALF_MULT;
            shadowLight.shadowMinZ = Math.max(0.1, lightDistance - depthHalf);
            shadowLight.shadowMaxZ = lightDistance + depthHalf;

            // (H) Position light autour caméra
            shadowLight.position.copyFrom(camPosRender).subtractInPlace(lightDir.scale(lightDistance));

            // (I) Snap stable (réduit shimmer) — CORRECTION SIGNE dx/dy
            const worldUnitsPerTexel = (2.0 * shadowRange) / SHADOW_MAP_SIZE;

            Matrix.LookAtLHToRef(
                shadowLight.position,
                shadowLight.position.add(shadowLight.direction),
                Vector3.Up(),
                lightView
            );
            Vector3.TransformCoordinatesToRef(camPosRender, lightView, centerLS);

            const snappedX = Math.round(centerLS.x / worldUnitsPerTexel) * worldUnitsPerTexel;
            const snappedY = Math.round(centerLS.y / worldUnitsPerTexel) * worldUnitsPerTexel;

            // dx/dy = center - snapped (pas l’inverse)
            const dx = centerLS.x - snappedX;
            const dy = centerLS.y - snappedY;

            // axes right/up de la light en world/render-space (robuste si dir ~ up)
            const upRef = Math.abs(Vector3.Dot(lightDir, Vector3.Up())) > 0.98 ? Vector3.Forward() : Vector3.Up();
            Vector3.CrossToRef(upRef, lightDir, lightRight);
            lightRight.normalize();
            Vector3.CrossToRef(lightDir, lightRight, lightUp);
            lightUp.normalize();

            // déplacer la light dans son plan ortho
            shadowLight.position.addInPlace(lightRight.scale(dx));
            shadowLight.position.addInPlace(lightUp.scale(dy));

            // (J) Push lightMatrix finale (après position + snap)
            shadowCtx.lightMatrix.copyFrom(shadowGen.getTransformMatrix());
        });

        const stars: StarGlowSource[] = [];

        for (const sys of loadedSystems.values()) {
            for (const body of sys.bodies.values()) {
                if (body.bodyType === "star") {
                    const light = (body as any).starLight; // ou body.starLight si typé

                    stars.push({
                        posWorldDouble: body.positionWorldDouble,
                        radius: body.radiusSim,
                        color: light?.color ?? new Vector3(1, 1, 1),
                        intensity: light?.intensity ?? 1.0,
                    });
                }
            }
        }

        // après création de `camera`
        attachStarRayMarchingPostProcess(scene, camera, stars);

        // RACCOURCI: T pour se téléporter
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === "t") {
                const sol = loadedSystems.get("AlphaCentauri");
                const pluto = sol?.bodies.get("Proxima_b");
                if (!pluto) return;

                teleportToEntity(camera, pluto.positionWorldDouble, pluto.diameterSim, 20);
                lod.resetNow();
                pickActivePlanetNow();
                lastPickMs = performance.now();
            }
        });

        new PostProcess('Pipeline', scene, camera);

        // Skybox
        const skybox = MeshBuilder.CreateBox('skyBox', { size: 1_000 }, scene);
        const skyboxMaterial = new StandardMaterial('skyBox', scene);
        skyboxMaterial.backFaceCulling = false;
        skyboxMaterial.disableLighting = true;
        skybox.material = skyboxMaterial;
        skybox.infiniteDistance = true;
        skyboxMaterial.reflectionTexture = new CubeTexture(`${process.env.ASSETS_URL}/skybox`, scene);
        skyboxMaterial.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
        skyboxMaterial.disableDepthWrite = true;
        skybox.isPickable = false;
        skybox.renderingGroupId = 0;

        // --- HUD Vitesse + distance
        let emaMS = 0;
        let lastHudUpdate = performance.now();
        const TAU = 0.1;
        const HUD_RATE_MS = 250;
        let lastDistLog = performance.now();
        const DIST_LOG_RATE_MS = 500;

        scene.onBeforeRenderObservable.add(() => {
            const now = performance.now();
            if (now - lastDistLog >= DIST_LOG_RATE_MS) {
                // P0: distance vers la vraie position WorldDouble
                const dSim = camera.distanceToSim(body.positionWorldDouble);
                const dKm = ScaleManager.toRealUnits(dSim);
                console.log(`${body.name}: ${dKm.toFixed(0)} km`);
                lastDistLog = now;
            }

            const dt = scene.getEngine().getDeltaTime() / 1000;
            const alpha = 1 - Math.exp(-dt / TAU);
            const speedMS = ScaleManager.simSpeedToMetersPerSec(camera.speedSim);
            emaMS += (speedMS - emaMS) * alpha;

            const nowHud = performance.now();
            if (nowHud - lastHudUpdate >= HUD_RATE_MS) {
                const displayMS = Math.round(emaMS * 10) / 10;
                gui.setSpeed(displayMS);
                lastHudUpdate = nowHud;
            }
        });

        engine.runRenderLoop(() => {
            scene.render();
        });

        return scene;
    }
}
