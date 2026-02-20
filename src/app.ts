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
        // Terrain shadows (2 cascades: near + mid/far)
        // All distances below are in **simulation units** (= Render-space, since camera is at origin).
        // --------------------
        const SHADOW_MAP_SIZE_NEAR = 4096;
        const SHADOW_MAP_SIZE_FAR = 2048;

        const NEAR_MIN_RANGE = 6000;
        const NEAR_MAX_RANGE = 26000;
        const FAR_MIN_RANGE = 30000;
        const FAR_MAX_RANGE = 140000;

        const RANGE_LERP = 0.12;
        const DEPTH_HALF_MULT_NEAR = 2.0;
        const DEPTH_HALF_MULT_FAR = 2.8;
        const LIGHT_DIST_MULT_NEAR = 2.5;
        const LIGHT_DIST_MULT_FAR = 2.8;
        const LIGHT_DIST_ADD = 5000;

        // Split in render-space distance fragment->camera. Set blend to 0 for hard split validation.
        const SHADOW_SPLIT_DIST = 22000;
        const SHADOW_SPLIT_BLEND = 3500;

        let shadowRangeNear = 12000;
        let shadowRangeFar = 60000;

        const shadowLightNear = new DirectionalLight("terrainShadowLightNear", new Vector3(0, -1, 0), scene);
        shadowLightNear.intensity = 0;

        const shadowLightFar = new DirectionalLight("terrainShadowLightFar", new Vector3(0, -1, 0), scene);
        shadowLightFar.intensity = 0;

        const shadowGenNear = new ShadowGenerator(SHADOW_MAP_SIZE_NEAR, shadowLightNear, true);
        const shadowGenFar = new ShadowGenerator(SHADOW_MAP_SIZE_FAR, shadowLightFar, true);

        // Biais côté génération de shadow map (anti-acne), réglables indépendamment par cascade
        shadowGenNear.bias = 0.0015;
        shadowGenNear.normalBias = 0.6;
        shadowGenFar.bias = 0.0022;
        shadowGenFar.normalBias = 0.9;

        const shadowCtx: TerrainShadowContext = {
            near: {
                shadowGen: shadowGenNear,
                shadowMap: shadowGenNear.getShadowMapForRendering()!,
                lightMatrix: new Matrix(),
                texelSize: new Vector2(1 / SHADOW_MAP_SIZE_NEAR, 1 / SHADOW_MAP_SIZE_NEAR),
                bias: 0.00025,
                normalBias: 0.0020,
                darkness: 1.0,
            },
            far: {
                shadowGen: shadowGenFar,
                shadowMap: shadowGenFar.getShadowMapForRendering()!,
                lightMatrix: new Matrix(),
                texelSize: new Vector2(1 / SHADOW_MAP_SIZE_FAR, 1 / SHADOW_MAP_SIZE_FAR),
                bias: 0.00035,
                normalBias: 0.0028,
                darkness: 1.0,
            },
            splitDistance: SHADOW_SPLIT_DIST,
            splitBlend: SHADOW_SPLIT_BLEND,
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
            shadowLightNear.direction.copyFrom(lightDir);
            shadowLightFar.direction.copyFrom(lightDir);

            // (D) Centre autour caméra (Render-space)
            camPosRender.copyFrom(camera.position);

            const distToCenter = camera.distanceToSim(planetCenterWD);
            const altitude = Math.max(0, distToCenter - activePlanet.radiusSim);

            function quantizeRange(r: number, minR: number, maxR: number) {
                const base = 2000;
                const q = base * Math.pow(2, Math.round(Math.log(r / base) / Math.log(2)));
                return Math.min(maxR, Math.max(minR, q));
            }

            const nearTarget = Math.min(
                NEAR_MAX_RANGE,
                Math.max(NEAR_MIN_RANGE, altitude * 1.8 + 2000.0)
            );
            const farTarget = Math.min(
                FAR_MAX_RANGE,
                Math.max(FAR_MIN_RANGE, nearTarget * 2.6 + altitude * 1.1)
            );

            shadowRangeNear += (quantizeRange(nearTarget, NEAR_MIN_RANGE, NEAR_MAX_RANGE) - shadowRangeNear) * RANGE_LERP;
            shadowRangeFar += (quantizeRange(farTarget, FAR_MIN_RANGE, FAR_MAX_RANGE) - shadowRangeFar) * RANGE_LERP;

            const upRef = Math.abs(Vector3.Dot(lightDir, Vector3.Up())) > 0.98 ? Vector3.Forward() : Vector3.Up();
            Vector3.CrossToRef(upRef, lightDir, lightRight);
            lightRight.normalize();
            Vector3.CrossToRef(lightDir, lightRight, lightUp);
            lightUp.normalize();

            function updateShadowCascade(
                light: DirectionalLight,
                generator: ShadowGenerator,
                range: number,
                mapSize: number,
                depthHalfMult: number,
                lightDistMult: number,
                outMatrix: Matrix
            ) {
                const lightDistance = range * lightDistMult + LIGHT_DIST_ADD;

                light.orthoLeft = -range;
                light.orthoRight = range;
                light.orthoTop = range;
                light.orthoBottom = -range;

                const depthHalf = range * depthHalfMult;
                light.shadowMinZ = Math.max(0.1, lightDistance - depthHalf);
                light.shadowMaxZ = lightDistance + depthHalf;

                light.position.copyFrom(camPosRender).subtractInPlace(lightDir.scale(lightDistance));

                const worldUnitsPerTexel = (2.0 * range) / mapSize;
                Matrix.LookAtLHToRef(
                    light.position,
                    light.position.add(light.direction),
                    Vector3.Up(),
                    lightView
                );
                Vector3.TransformCoordinatesToRef(camPosRender, lightView, centerLS);

                const snappedX = Math.round(centerLS.x / worldUnitsPerTexel) * worldUnitsPerTexel;
                const snappedY = Math.round(centerLS.y / worldUnitsPerTexel) * worldUnitsPerTexel;

                const dx = centerLS.x - snappedX;
                const dy = centerLS.y - snappedY;

                light.position.addInPlace(lightRight.scale(dx));
                light.position.addInPlace(lightUp.scale(dy));

                outMatrix.copyFrom(generator.getTransformMatrix());
            }

            updateShadowCascade(
                shadowLightNear,
                shadowGenNear,
                shadowRangeNear,
                SHADOW_MAP_SIZE_NEAR,
                DEPTH_HALF_MULT_NEAR,
                LIGHT_DIST_MULT_NEAR,
                shadowCtx.near.lightMatrix
            );

            updateShadowCascade(
                shadowLightFar,
                shadowGenFar,
                shadowRangeFar,
                SHADOW_MAP_SIZE_FAR,
                DEPTH_HALF_MULT_FAR,
                LIGHT_DIST_MULT_FAR,
                shadowCtx.far.lightMatrix
            );
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
