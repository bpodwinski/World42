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

        // Debug camera
        const debugCam = new UniversalCamera('debugCam', Vector3.Zero(), scene);
        debugCam.minZ = camera.minZ;
        debugCam.maxZ = camera.maxZ;
        debugCam.fov = camera.fov;
        debugCam.inputs.clear();

        // WorldDouble debug cam
        let debugDoublePos = camera.doublepos.clone().add(new Vector3(0, 0, body.diameter * 1.5));
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
            rescoreMs: 200,
            applyDebugEveryFrame: true,
        });

        lod.start();

        // RACCOURCI: T pour se téléporter
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === "t") {
                const sol = loadedSystems.get("AlphaCentauri");
                const pluto = sol?.bodies.get("Proxima_b");
                if (!pluto) return;

                teleportToEntity(camera, pluto.positionWorldDouble, pluto.diameter, 20);
                lod.resetNow();
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
