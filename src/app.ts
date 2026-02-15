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
import { PlanetCDLOD } from './game_world/stellar_system/stellar_catalog_loader';
import { LodScheduler } from './systems/lod/lod_scheduler';
import { attachStarRayMarchingPostProcess, type StarGlowSource } from "./core/render/star_raymarch_postprocess";
import { DirectionalLight, ShadowGenerator, Matrix, Vector2 } from "@babylonjs/core";
import { TerrainShader, type TerrainShadowContext } from "./game_objects/planets/rocky_planet/terrains_shader";
import { createBaseScene } from './core/render/create_scene';
import { buildStellarSystemPlanetsCDLOD, loadStellarSystemRuntime } from './game_world/stellar_system/stellar_system_runtime';
import { TerrainShadowSystem } from './game_objects/planets/rocky_planet/terrain_shadow';

export class FloatingCameraScene {
    public static async CreateScene(
        engine: Engine | WebGPUEngine,
        canvas: HTMLCanvasElement
    ): Promise<Scene> {
        // Create scene
        const scene = createBaseScene(engine);

        // Load stellar system
        const runtime = await loadStellarSystemRuntime(scene, planetsJson, {
            preferredSystemId: "Sol",
            preferredBodyName: "Mercury",
        });
        const loadedSystems = runtime.loadedSystems;
        const activeSystem = runtime.activeSystem;
        const body = runtime.spawnBody;

        // GUI
        const gui = new GuiManager(scene);
        gui.setMouseCrosshairVisible(true);

        // -------------------------
        // IMPORTANT (P0):
        // node.position est en Render-space (souvent 0),
        // la vraie position est body.positionWorldDouble (WorldDouble).
        // -------------------------
        const planetTargetWorldDouble = body.positionWorldDouble.clone();
        planetTargetWorldDouble.y += body.diameter * 0.52;

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

        const { mergedCDLOD, roots } = buildStellarSystemPlanetsCDLOD(
            scene,
            camera,
            loadedSystems,
            { maxLevel: 10, resolution: 64 }
        );

        const lod = new LodScheduler(scene, camera, roots, {
            maxConcurrent: 6,
            maxStartsPerFrame: 2,
            rescoreMs: 100,
            applyDebugEveryFrame: true,
        });

        lod.start();

        // Debug camera
        // const debugCam = new UniversalCamera('debugCam', Vector3.Zero(), scene);
        // debugCam.minZ = camera.minZ;
        // debugCam.maxZ = camera.maxZ;
        // debugCam.fov = camera.fov;
        // debugCam.inputs.clear();

        // // WorldDouble debug cam
        // let debugDoublePos = camera.doublepos.clone().add(new Vector3(0, 0, body.diameter * 1.5));
        // let debugDoubleTgt = body.positionWorldDouble.clone();

        // camera.viewport = new Viewport(0, 0, 1, 1);
        // debugCam.viewport = new Viewport(0.5, 0.5, 0.5, 0.5);
        // scene.activeCameras = [camera, debugCam];

        // const tmpTgtRender = new Vector3();
        // scene.onBeforeRenderObservable.add(() => {
        //     camera.toRenderSpace(debugDoublePos, debugCam.position);
        //     camera.toRenderSpace(debugDoubleTgt, tmpTgtRender);
        //     debugCam.setTarget(tmpTgtRender);
        // });

        // const keys = new Set<string>();
        // window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
        // window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

        // scene.onBeforeRenderObservable.add(() => {
        //     const dt = engine.getDeltaTime() / 1000;
        //     const speed = body.diameter * 0.2 * dt;

        //     const fwd = debugCam.getDirection(Vector3.Forward());
        //     const right = debugCam.getDirection(Vector3.Right());
        //     const up = debugCam.getDirection(Vector3.Up());

        //     if (keys.has('i')) debugDoublePos.addInPlace(fwd.scale(speed));
        //     if (keys.has('k')) debugDoublePos.addInPlace(fwd.scale(-speed));
        //     if (keys.has('l')) debugDoublePos.addInPlace(right.scale(speed));
        //     if (keys.has('j')) debugDoublePos.addInPlace(right.scale(-speed));
        //     if (keys.has('u')) debugDoublePos.addInPlace(up.scale(speed));
        //     if (keys.has('o')) debugDoublePos.addInPlace(up.scale(-speed));
        // });

        const shadowSystem = new TerrainShadowSystem(
            {
                scene,
                engine,
                camera,
                planets: Array.from(mergedCDLOD.values()),
            },
            {
                shadowMapSize: 4096,
                minShadowRange: 6000,
                maxShadowRange: 50000,
                rangeLerp: 0.12,
                depthHalfMult: 2.0,
                lightDistMult: 2.5,
                lightDistAdd: 5000,
                pickIntervalMs: 250,
                generatorBias: 0.0015,
                generatorNormalBias: 0.6,
                shaderBias: 0.00025,
                darkness: 1.0,
            }
        );

        const disposeShadows = shadowSystem.attach();
        scene.onDisposeObservable.add(() => disposeShadows());

        const stars: StarGlowSource[] = [];

        for (const sys of loadedSystems.values()) {
            for (const body of sys.bodies.values()) {
                if (body.bodyType === "star") {
                    const light = (body as any).starLight; // ou body.starLight si typé

                    stars.push({
                        posWorldDouble: body.positionWorldDouble,
                        radius: body.diameter * 0.5,
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

                teleportToEntity(camera, pluto.positionWorldDouble, pluto.diameter, 20);
                lod.resetNow();
                shadowSystem.forcePickNow();
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
