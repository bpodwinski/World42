import {
    CubeTexture,
    Engine,
    MeshBuilder,
    Scene,
    StandardMaterial,
    Texture,
    WebGPUEngine,
} from '@babylonjs/core';
import { OriginCamera } from '../core/camera/camera_manager';
import { teleportToEntity } from '../core/camera/teleport_entity';
import { GuiManager } from '../core/gui/gui_manager';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import { PostProcess } from '../core/render/postprocess_manager';
import { ScaleManager } from '../core/scale/scale_manager';
import type { LoadedBody, LoadedSystem } from '../game_world/stellar_system/stellar_catalog_loader';
import type { LodController } from './setup_lod_and_shadows';

export type RuntimeSetupOptions = {
    scene: Scene;
    engine: Engine | WebGPUEngine;
    camera: OriginCamera;
    gui: GuiManager;
    spawnBody: LoadedBody;
    loadedSystems: Map<string, LoadedSystem>;
    lod: LodController;
    refreshActivePlanetSelection: () => void;
    disposables: DisposableRegistry;
};

export function setupRuntime({
    scene,
    engine,
    camera,
    gui,
    spawnBody,
    loadedSystems,
    lod,
    refreshActivePlanetSelection,
    disposables,
}: RuntimeSetupOptions): void {
    disposables.addDomListener(window, 'keydown', (event) => {
        if (event.key.toLowerCase() !== 't') return;

        const system = loadedSystems.get('AlphaCentauri');
        const destination = system?.bodies.get('Proxima_b');
        if (!destination) return;

        teleportToEntity(camera, destination.positionWorldDouble, destination.diameterSim, 20);
        lod.resetNow();
        refreshActivePlanetSelection();
    });

    new PostProcess('Pipeline', scene, camera);

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

    let emaMS = 0;
    let lastHudUpdate = performance.now();
    let lastDistLog = performance.now();
    const TAU = 0.1;
    const HUD_RATE_MS = 250;
    const DIST_LOG_RATE_MS = 500;

    const hudObserver = scene.onBeforeRenderObservable.add(() => {
        const now = performance.now();
        if (now - lastDistLog >= DIST_LOG_RATE_MS) {
            const distanceSim = camera.distanceToSim(spawnBody.positionWorldDouble);
            const distanceKm = ScaleManager.toRealUnits(distanceSim);
            console.log(`${spawnBody.name}: ${distanceKm.toFixed(0)} km`);
            lastDistLog = now;
        }

        const dt = scene.getEngine().getDeltaTime() / 1000;
        const alpha = 1 - Math.exp(-dt / TAU);
        const speedMS = ScaleManager.simSpeedToMetersPerSec(camera.speedSim);
        emaMS += (speedMS - emaMS) * alpha;

        const nowHud = performance.now();
        if (nowHud - lastHudUpdate >= HUD_RATE_MS) {
            gui.setSpeed(Math.round(emaMS * 10) / 10);
            lastHudUpdate = nowHud;
        }
    });
    disposables.addBabylonObserver(scene.onBeforeRenderObservable, hudObserver);

    const renderLoop = () => scene.render();
    engine.runRenderLoop(renderLoop);
    disposables.add(() => engine.stopRenderLoop(renderLoop));
}
