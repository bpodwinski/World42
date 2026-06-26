import {
    CubeTexture,
    Engine,
    EngineInstrumentation,
    MeshBuilder,
    Scene,
    SceneInstrumentation,
    StandardMaterial,
    Texture,
    Vector3,
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

    // --- Performance instrumentation (perf HUD + headless capture) ---
    // Capture is gated: off until the HUD is toggled on, so normal runs are
    // unaffected by GPU-timestamp / frame-time capture overhead.
    const sceneInstr = new SceneInstrumentation(scene);
    const engineInstr = new EngineInstrumentation(engine);
    disposables.add(() => sceneInstr.dispose());
    disposables.add(() => engineInstr.dispose());

    const setCaptureEnabled = (on: boolean): void => {
        sceneInstr.captureFrameTime = on;
        engineInstr.captureGPUFrameTime = on;
    };

    // JS heap (Chromium only). usedJSHeapSize is the live retained JS memory; a rising
    // trend across a stationary scene is the signal for a leak (e.g. node churn / no pooling).
    type PerfMemory = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    const perfMemory = (): PerfMemory | undefined =>
        (performance as unknown as { memory?: PerfMemory }).memory;

    const sampleStats = () => {
        const cbt = lod.getCbtStats();
        const frameMs = sceneInstr.frameTimeCounter.lastSecAverage;
        const gpuMs = engineInstr.gpuFrameTimeCounter.lastSecAverage / 1e6; // ns → ms
        const mem = perfMemory();
        return {
            fps: engine.getFps(),
            frameMs,
            gpuMs,
            drawCalls: sceneInstr.drawCallsCounter.current,
            activeIndices: scene.getActiveIndices(),
            // RAM: live JS heap in MB (-1 where the browser does not expose performance.memory).
            jsHeapMB: mem ? mem.usedJSHeapSize / 1048576 : -1,
            cbt,
        };
    };

    const formatPerf = (s: ReturnType<typeof sampleStats>): string => {
        const f = (n: number, d = 1) => n.toFixed(d);
        return [
            `FPS ${Math.round(s.fps)}  frame ${f(s.frameMs)}ms`,
            `gpu ${f(s.gpuMs)}ms  draws ${s.drawCalls}`,
            `ram ${s.jsHeapMB < 0 ? 'n/a' : f(s.jsHeapMB, 0) + 'MB'}  idx ${(s.activeIndices / 1000).toFixed(0)}k`,
            `cbt leaves ${s.cbt.leafCount}  verts ${s.cbt.vertexCount}`,
            `split/f ${s.cbt.splitsThisFrame}  merge/f ${s.cbt.mergesThisFrame}`,
            `classify ${f(s.cbt.classifyMs, 2)}ms  rebuild ${f(s.cbt.rebuildMs, 2)}ms`,
        ].join('\n');
    };

    disposables.addDomListener(window, 'keydown', (event) => {
        if (event.key.toLowerCase() !== 'p') return;
        const visible = gui.togglePerf();
        setCaptureEnabled(visible);
    });

    // Dev-only hook for deterministic headless capture (scripts/cbt_perf_capture.mjs).
    const tmpRenderTarget = new Vector3();
    const perfHook = {
        enableCapture: (on: boolean) => setCaptureEnabled(on),
        // Debug fragment perf-profiling mask read by OcbtSource each frame: bit0 skip slope normal,
        // bit1 skip df64 ground detail, bit2 skip crater rays. Toggle blocks, watch gpuMs.
        setPerfMask: (mask: number) => {
            (globalThis as unknown as { __ocbtPerfMask?: number }).__ocbtPerfMask = mask | 0;
        },
        getStats: () => sampleStats(),
        getPlanets: () => [...lod.getCbtPlanetInfo(), ...lod.getCdlodPlanetInfo()],
        setCameraDoublePos: (x: number, y: number, z: number) => {
            camera.doublepos.set(x, y, z);
            lod.resetNow();
        },
        /** Orient the camera toward a WorldDouble point (render-space target). */
        lookAtDoublePos: (x: number, y: number, z: number) => {
            tmpRenderTarget.set(
                x - camera.doublepos.x,
                y - camera.doublepos.y,
                z - camera.doublepos.z
            );
            camera.setTarget(tmpRenderTarget);
        },
    };
    (window as unknown as { __world42Perf?: typeof perfHook }).__world42Perf = perfHook;
    disposables.add(() => {
        delete (window as unknown as { __world42Perf?: typeof perfHook }).__world42Perf;
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

    // Analytic hard-floor ground collision: keep the camera above the CBT/OCBT
    // surface (the GPU terrain has no CPU mesh, so Babylon collision can't see it).
    // Runs after the steering controller's per-frame move (registered earlier).
    const GROUND_CLEARANCE_SIM = ScaleManager.toSimulationUnits(0.015); // ~15 m floor
    const groundObserver = scene.onBeforeRenderObservable.add(() => {
        lod.resolveGroundCollision(GROUND_CLEARANCE_SIM);
    });
    disposables.addBabylonObserver(scene.onBeforeRenderObservable, groundObserver);

    let emaMS = 0;
    let lastHudUpdate = performance.now();
    let lastDistLog = performance.now();
    const TAU = 0.1;
    const HUD_RATE_MS = 250;
    const DIST_LOG_RATE_MS = 500;

    // Altitude read-out for the perf HUD: distance to the NEAREST planet's surface,
    // in km and as a multiple of its radius (the unit the perf bench waypoints use).
    const tmpPlanetCenter = new Vector3();
    const formatAltitude = (): string => {
        const infos = [...lod.getCbtPlanetInfo(), ...lod.getCdlodPlanetInfo()];
        let bestKey = '';
        let bestDist = Infinity;
        let bestRadius = 1;
        for (const p of infos) {
            tmpPlanetCenter.set(p.center[0], p.center[1], p.center[2]);
            const d = Vector3.Distance(camera.doublepos, tmpPlanetCenter);
            if (d < bestDist) {
                bestDist = d;
                bestKey = p.key;
                bestRadius = p.radiusSim;
            }
        }
        if (!bestKey) return '';
        // Altitude above the ACTUAL terrain, not sea level: for a CBT/OCBT planet the nearest
        // ground info gives the analytic fbm height under the camera (same field the shader
        // renders). CDLOD planets fall back to sea level (their height field is worker-side).
        let groundRadius = bestRadius;
        const cbtGround = lod.getCbtGroundInfo();
        if (cbtGround && cbtGround.key === bestKey) groundRadius = cbtGround.groundRSim;
        const altKm = ScaleManager.toRealUnits(bestDist - groundRadius);
        const ratio = bestDist / bestRadius;
        const name = bestKey.split(':').pop() ?? bestKey;
        return `alt ${altKm.toFixed(0)}km  ${ratio.toFixed(2)}xR  ${name}`;
    };

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
            if (gui.isPerfVisible()) {
                const altLine = formatAltitude();
                const body = formatPerf(sampleStats());
                gui.setPerfText(altLine ? `${altLine}\n${body}` : body);
            }
            lastHudUpdate = nowHud;
        }
    });
    disposables.addBabylonObserver(scene.onBeforeRenderObservable, hudObserver);

    const renderLoop = () => scene.render();
    engine.runRenderLoop(renderLoop);
    disposables.add(() => engine.stopRenderLoop(renderLoop));
}
