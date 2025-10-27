import {
    Engine,
    Scene,
    Vector3,
    MeshBuilder,
    Color3,
    PointLight,
    Texture,
    PBRMetallicRoughnessMaterial,
    Mesh,
    StandardMaterial,
    CubeTexture,
    WebGPUEngine
} from '@babylonjs/core';
import '@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader';
import '@babylonjs/core/Debug/debugLayer';
import '@babylonjs/inspector';

import { PostProcess } from './core/render/postprocess-manager';
import { ScaleManager } from './core/scale/scale-manager';
import { FloatingEntity, OriginCamera } from './core/camera/camera-manager';
import { TextureManager } from './core/io/texture-manager';
import { io } from 'socket.io-client';
import { MouseSteerControlManager } from './core/control/mouse-steer-control-manager';
import { GuiManager } from './core/gui/gui-manager';

import { createCDLODForAllPlanets, loadSolarSystemFromJSON, precomputeAndRunLODLoop, type SystemJSON } from './game_world/solar_system/solar-system-loader';
import planetsJson from './game_world/solar_system/planets.json';

function toSystemJSON(raw: any): SystemJSON {
    const out: Record<string, {
        position_km: [number, number, number];
        diameter_km: number | null;
        rotation_period_days: number | null;
    }> = {};
    for (const [name, v] of Object.entries(raw)) {
        const arr = Array.isArray((v as any).position_km) ? (v as any).position_km as number[] : [0, 0, 0];
        const [x = 0, y = 0, z = 0] = arr;

        out[name] = {
            position_km: [x, y, z],
            diameter_km: (v as any).diameter_km ?? null,
            rotation_period_days: (v as any).rotation_period_days ?? null,
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

        const Sun = systemBodies.get('Sun');
        const Body = systemBodies.get('Mars');

        if (!Sun || !Body) {
            throw new Error('Planets JSON must at least contain "Sun" and "Body"');
        }

        scene.clearColor.set(0, 0, 0, 1);
        scene.collisionsEnabled = true;
        scene.textures.forEach((texture) => {
            texture.anisotropicFilteringLevel = 16;
        });

        // GUI
        const gui = new GuiManager(scene);
        gui.setMouseCrosshairVisible(true);

        let planetTarget = Body.node.position.clone();
        planetTarget.y += ScaleManager.toSimulationUnits(Body.radiusMeters ?? 0) * 1.02;

        let camera = new OriginCamera('camera', planetTarget, scene);
        camera.debugMode = true;
        camera.doubletgt = Sun.node.position.clone();

        camera.minZ = 0.001;
        camera.maxZ = 1_000_000;
        camera.fov = 0.9;
        camera.checkCollisions = true;
        camera.applyGravity = false;
        camera.ellipsoid = new Vector3(0.01, 0.01, 0.01);
        camera.inertia = 0;
        camera.inputs.clear();

        const dSim = camera.distanceToSim(Body.node.position);
        const dKm = ScaleManager.simDistanceToKm(dSim);
        const dM = ScaleManager.simDistanceToMeters(dSim);

        const control = new MouseSteerControlManager(camera, scene, canvas);
        control.gui = gui;

        const allCDLOD = createCDLODForAllPlanets(
            scene,
            camera,
            loadedSystem,
            {
                maxLevel: 8,
                resolution: 64,
                skip: (name) => name.toLowerCase() === "sun",
            }
        );

        precomputeAndRunLODLoop(scene, camera, allCDLOD);

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

        // Sun light entity à la position du Sun du loader
        let entSunLight = new FloatingEntity('entSunLight', scene);
        entSunLight.doublepos.set(Sun.node.position.x, Sun.node.position.y, Sun.node.position.z);
        camera.add(entSunLight);

        // Sun mesh (le tien), parenté à un FloatingEntity positionné via le loader
        const entSun = new FloatingEntity('entSun', scene);
        entSun.doublepos.set(Sun.node.position.x, Sun.node.position.y, Sun.node.position.z);
        camera.add(entSun);

        const sun = MeshBuilder.CreateSphere('sun', {
            segments: 64,
            diameter: (Sun.radiusMeters ? Sun.radiusMeters * 2 : ScaleManager.toSimulationUnits(1391000))
        });
        let sunMaterial = new PBRMetallicRoughnessMaterial('sunMaterial', scene);
        sunMaterial.emissiveTexture = new TextureManager('sun_surface_albedo.ktx2', scene);
        sunMaterial.emissiveColor = new Color3(1, 1, 1);
        sunMaterial.metallic = 0.0;
        sunMaterial.roughness = 0.0;
        sun.material = sunMaterial;
        sun.checkCollisions = true;
        sun.parent = entSun;

        // Map to store planet meshes (unused in current version)
        const planetMeshes = new Map<string, Mesh>();

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
                // Recalcule à chaque frame (origin flottant => positions haute précision)
                const dSim = camera.distanceToSim(Body.node.position);

                // Si tu as ajouté les alias :
                // const dKm = ScaleManager.simDistanceToKm(dSim);
                // Sinon, utilise toRealUnits (sim -> km) directement :
                const dKm = ScaleManager.toRealUnits(dSim);

                console.log(`Mercure: ${dKm.toFixed(0)} km (${(dKm / 1e6).toFixed(3)} Mm)`);

                lastDistLog = now;
            }

            // ... le reste de ton code HUD vitesse
            const speedMS = ScaleManager.simSpeedToMetersPerSec(camera.speedSim);
            const dt = scene.getEngine().getDeltaTime() / 1000;
            const alpha = 1 - Math.exp(-dt / TAU);
            emaMS += (speedMS - emaMS) * alpha;

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
