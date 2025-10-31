import {
    Engine,
    Scene,
    Vector3,
    MeshBuilder,
    Texture,
    StandardMaterial,
    CubeTexture,
    WebGPUEngine
} from '@babylonjs/core';
import '@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader';
import '@babylonjs/core/Debug/debugLayer';
import '@babylonjs/inspector';

import { PostProcess } from './core/render/postprocess_manager';
import { OriginCamera } from './core/camera/camera_manager';
import { MouseSteerControlManager } from './core/control/mouse_steer_control_manager';
import { GuiManager } from './core/gui/gui_manager';
import { createCDLODForAllPlanets, loadSolarSystemFromJSON, precomputeAndRunLODLoop, type SystemJSON } from './game_world/solar_system/solar_system_loader';
import planetsJson from './game_world/solar_system/data.json';
import { teleportToEntity } from './core/camera/teleport_entity';

function toSystemJSON(raw: any): SystemJSON {
    const out: SystemJSON = {};

    for (const [name, vAny] of Object.entries(raw)) {
        const v = vAny as {
            type?: string;
            position_km?: number[];
            diameter_km?: number;
            rotation_period_days?: number | null;
        };

        const [x = 0, y = 0, z = 0] = Array.isArray(v.position_km) ? v.position_km as number[] : [0, 0, 0];

        // si pas de type fourni → "planet" par défaut (plus de cas spécial Sun)
        const inferredType =
            typeof v.type === "string" && v.type.trim().length > 0
                ? v.type.toLowerCase()
                : "planet";

        out[name] = {
            type: inferredType,
            position_km: [x, y, z],
            diameter_km: Number(v.diameter_km ?? 0),
            rotation_period_days: (v.rotation_period_days ?? null) as number | null,
        };
    }

    return out;
}

export class FloatingCameraScene {
    public static async CreateScene(
        engine: Engine | WebGPUEngine,
        canvas: HTMLCanvasElement
    ): Promise<Scene> {
        let scene = new Scene(engine);
        scene.clearColor.set(0, 0, 0, 1);
        scene.collisionsEnabled = true;

        // rework to params
        const normalized = toSystemJSON(planetsJson);
        const loadedSystem = await loadSolarSystemFromJSON(scene, normalized);
        const systemBodies = loadedSystem.bodies;
        const body = systemBodies.get('Mercury');

        if (!body) {
            throw new Error('Bodies JSON must at least contain "Sun" and "Body"');
        }

        scene.clearColor.set(0, 0, 0, 1);
        scene.collisionsEnabled = true;
        scene.textures.forEach((texture) => {
            texture.anisotropicFilteringLevel = 16;
        });

        // GUI
        const gui = new GuiManager(scene);
        gui.setMouseCrosshairVisible(true);

        let planetTarget = body.node.position.clone();
        planetTarget.y += body.diameter * 0.52;

        let camera = new OriginCamera('camera', planetTarget, scene);
        camera.debugMode = true;
        camera.minZ = 0.001;
        camera.maxZ = 1_000_000;
        camera.fov = 0.6;
        camera.checkCollisions = true;
        camera.applyGravity = false;
        camera.ellipsoid = new Vector3(0.01, 0.01, 0.01);
        camera.inertia = 0;
        camera.inputs.clear();

        const control = new MouseSteerControlManager(camera, scene, canvas);
        control.gui = gui;

        const allCDLOD = createCDLODForAllPlanets(
            scene,
            camera,
            loadedSystem,
            {
                maxLevel: 12,
                resolution: 40,
                skip: (name) => name.toLowerCase() === "sun",
            }
        );

        precomputeAndRunLODLoop(scene, camera, allCDLOD);

        // RACCOURCI: T pour se téléporter
        window.addEventListener('keydown', (ev) => {
            if (ev.key.toLowerCase() === 't') {
                const pluto = systemBodies.get('Pluto');
                if (!pluto) {
                    console.warn("[teleport] La planète 'Pluto' est introuvable dans systemBodies.");
                    return;
                }

                teleportToEntity(
                    camera,
                    pluto.node.position,
                    pluto.diameter,
                    20
                );
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
        skyboxMaterial.reflectionTexture = new CubeTexture(
            `${process.env.ASSETS_URL}/skybox`,
            scene
        );
        skyboxMaterial.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
        skyboxMaterial.disableDepthWrite = true;
        skybox.isPickable = false;
        skybox.renderingGroupId = 0;

        // --- HUD Vitesse (lissé + throttlé) -----------------------------------------
        let emaMS = 0;
        let lastHudUpdate = performance.now();
        const TAU = 0.1;
        const HUD_RATE_MS = 250;
        let lastDistLog = performance.now();
        const DIST_LOG_RATE_MS = 500;

        scene.onBeforeRenderObservable.add(() => {
            const now = performance.now();
            if (now - lastDistLog >= DIST_LOG_RATE_MS) {
                const dSim = camera.distanceToSim(body.node.position);

                console.log(`${body.name}: ${dSim.toFixed(0)} km`);

                lastDistLog = now;
            }

            // ... le reste de ton code HUD vitesse
            const dt = scene.getEngine().getDeltaTime() / 1000;
            const alpha = 1 - Math.exp(-dt / TAU);
            emaMS += (camera.speedSim - emaMS) * alpha;

            const nowHud = performance.now();
            if (nowHud - lastHudUpdate >= HUD_RATE_MS) {
                const displayMS = Math.round(emaMS * 10) / 10;
                gui.setSpeed(displayMS);
                lastHudUpdate = nowHud;
            }
        });

        // Render loop
        engine.runRenderLoop(() => {
            scene.render();
        });

        return scene;
    }
}
