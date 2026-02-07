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
import { createCDLODForAllPlanets, loadSolarSystemFromJSON, precomputeAndRunLODLoop, type SystemJSON } from './game_world/solar_system/solar_system_loader';
import planetsJson from './game_world/solar_system/data.json';
import { teleportToEntity } from './core/camera/teleport_entity';
import { ScaleManager } from './core/scale/scale_manager';

export class FloatingCameraScene {
    public static async CreateScene(
        engine: Engine | WebGPUEngine,
        canvas: HTMLCanvasElement
    ): Promise<Scene> {
        let scene = new Scene(engine);
        scene.clearColor.set(0, 0, 0, 1);
        scene.collisionsEnabled = true;

        // rework to params
        const loadedSystem = await loadSolarSystemFromJSON(scene, planetsJson);
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

        let camera = new OriginCamera('camera_player', planetTarget, scene);
        camera.debugMode = true;
        camera.minZ = 0.001;
        camera.maxZ = 1_000_000;
        camera.fov = 1.2;
        camera.applyGravity = false;
        camera.inertia = 0;
        camera.inputs.clear();
        camera.checkCollisions = false;

        // Collider mesh invisible (Render-space)
        const camCollider = MeshBuilder.CreateSphere("camCollider", { segments: 64, diameter: 0.05 }, scene);
        // diamètre 6 => rayon 3 (à ajuster)
        camCollider.isVisible = false;
        camCollider.isPickable = false;
        camCollider.checkCollisions = true;
        camCollider.position.set(0, 0, 0);
        // Taille collision (demi-axes). Ici 0.005 => rayon 0.005 si ton monde est en "km" => 5m
        camCollider.ellipsoid = new Vector3(0.05, 0.05, 0.05);
        // Optionnel: décale l’ellipsoïde vers le bas/haut pour simuler “pieds”
        camCollider.ellipsoidOffset = new Vector3(0.05, 0.05, 0.05);

        // Reset collider après l'intégration floating-origin (évite de ré-intégrer le même offset)
        scene.onAfterActiveMeshesEvaluationObservable.add(() => {
            // OriginCamera fait: doublepos += camera.position; camera.position = 0
            // donc on recentre aussi le collider
            camCollider.position.set(0, 0, 0);
        });

        const control = new MouseSteerControlManager(camera, scene, canvas, camCollider, {});
        control.gui = gui;

        // Debug camera
        const debugCam = new UniversalCamera('debugCam', Vector3.Zero(), scene);
        debugCam.minZ = camera.minZ;
        debugCam.maxZ = camera.maxZ;
        debugCam.fov = camera.fov;
        debugCam.inputs.clear(); // on la contrôle manuellement (optionnel)

        // Position "monde" (double precision) pour la debug cam
        let debugDoublePos = camera.doublepos.clone().add(new Vector3(0, 0, body.diameter * 1.5));
        let debugDoubleTgt = body.node.position.clone();

        // Affichage en picture-in-picture (en haut à droite)
        camera.viewport = new Viewport(0, 0, 1, 1);
        debugCam.viewport = new Viewport(0.5, 0.5, 0.5, 0.5);
        scene.activeCameras = [camera, debugCam];

        // Mise à jour de la debugCam en render-space via l'origine (floating origin) de "camera"
        const tmpTgtRender = new Vector3();
        scene.onBeforeRenderObservable.add(() => {
            // renderPos = worldPos - camera.doublepos
            camera.toRenderSpace(debugDoublePos, debugCam.position);
            camera.toRenderSpace(debugDoubleTgt, tmpTgtRender);
            debugCam.setTarget(tmpTgtRender);
        });

        const keys = new Set<string>();
        window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
        window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

        scene.onBeforeRenderObservable.add(() => {
            const dt = engine.getDeltaTime() / 1000;
            const speed = body.diameter * 0.2 * dt;

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

        const allCDLOD = createCDLODForAllPlanets(
            scene,
            camera,
            loadedSystem,
            {
                maxLevel: 16,
                resolution: 64,
            }
        );

        precomputeAndRunLODLoop(scene, camera, allCDLOD);

        // RACCOURCI: T pour se téléporter
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 't') {
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

                const dKm = ScaleManager.toRealUnits(dSim);
                console.log(`${body.name}: ${dKm.toFixed(0)} km`);

                lastDistLog = now;
            }

            // ... le reste de ton code HUD vitesse
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

        // Render loop
        engine.runRenderLoop(() => {
            scene.render();
        });

        return scene;
    }
}
