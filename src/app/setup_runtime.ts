import {
    EngineInstrumentation,
    Scene,
    SceneInstrumentation,
    Vector3,
    WebGPUEngine,
} from '@babylonjs/core';
import { OriginCamera } from '../core/camera/camera_manager';
import { teleportToEntity } from '../core/camera/teleport_entity';
import { GuiManager } from '../core/gui/gui_manager';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import { attachFrameGraph } from '../core/render/frame_graph';
import type { Fsr1Options } from '../core/render/fsr1_postprocess';
import { installBenchFlight, type BenchPlanet } from './bench_flight';
import type { StarGlowSource, StarOccluder } from '../core/render/star_raymarch_postprocess';
import {
    pickNearestAtmosphere,
    type AtmosphereSource
} from '../core/render/atmosphere_postprocess';
import { loadStarCatalog } from '../core/io/star_catalog';
import { createStarfieldRenderer } from '../core/render/starfield_renderer';
import { ScaleManager } from '../core/scale/scale_manager';
import type { LoadedBody, LoadedSystem } from '../game_world/stellar_system/stellar_catalog_loader';
import type { LodController } from './setup_lod_and_shadows';

export type RuntimeSetupOptions = {
    scene: Scene;
    engine: WebGPUEngine;
    camera: OriginCamera;
    gui: GuiManager;
    spawnBody: LoadedBody;
    loadedSystems: Map<string, LoadedSystem>;
    lod: LodController;
    refreshActivePlanetSelection: () => void;
    stars: StarGlowSource[];
    occluders: StarOccluder[];
    atmospheres: AtmosphereSource[];
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
    stars,
    occluders,
    atmospheres,
    disposables,
}: RuntimeSetupOptions): {
    fsr1RenderScale: number;
    setFsr1RenderScale: (scale: number) => void;
} {
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

    // OS-level GPU stats bridge: the browser cannot read GPU utilization, so the optional
    // scripts/gpu_hud_bridge.ps1 helper writes live nvidia-smi values to public/gpu_stats.json
    // and the HUD polls it (same-origin). Absent/stale => the HUD shows "GPU% n/a". Polling runs
    // ONLY while capture/HUD is on, so normal runs make no extra requests.
    type OsGpu = { util: number; vramUsed: number; vramTotal: number; clock: number; power: number };
    let osGpu: { data: OsGpu; recvMs: number } | null = null;
    let osGpuTimer: ReturnType<typeof setInterval> | undefined;
    const pollOsGpu = (): void => {
        fetch(`/gpu_stats.json?t=${Math.floor(performance.now())}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: OsGpu | null) => {
                if (d && typeof d.util === 'number') {
                    osGpu = { data: d, recvMs: performance.now() };
                }
            })
            .catch(() => {
                /* bridge not running — leave osGpu to go stale (HUD shows n/a) */
            });
    };

    const setCaptureEnabled = (on: boolean): void => {
        sceneInstr.captureFrameTime = on;
        engineInstr.captureGPUFrameTime = on;
        if (on && osGpuTimer === undefined) {
            pollOsGpu();
            osGpuTimer = setInterval(pollOsGpu, 1000);
        } else if (!on && osGpuTimer !== undefined) {
            clearInterval(osGpuTimer);
            osGpuTimer = undefined;
            osGpu = null;
        }
    };
    disposables.add(() => {
        if (osGpuTimer !== undefined) clearInterval(osGpuTimer);
    });

    // JS heap (Chromium only). usedJSHeapSize is the live retained JS memory; a rising
    // trend across a stationary scene is the signal for a leak (e.g. node churn / no pooling).
    type PerfMemory = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    const perfMemory = (): PerfMemory | undefined =>
        (performance as unknown as { memory?: PerfMemory }).memory;

    // FSR1 spatial upscaling config (single source of truth — also passed to attachFrameGraph below).
    // The scene + all intermediate passes render at `renderScale` of the backbuffer; EASU+RCAS upscale
    // to full res. Set to undefined to disable and restore the native-resolution pipeline.
    // renderScale is live-tunable from the options menu (rebuilds the graph) and persisted here.
    const FSR1_LS_KEY = 'world42.fsr1RenderScale';
    const clampScale = (s: number) => Math.max(0.5, Math.min(1, s));
    const loadSavedScale = (): number | null => {
        try {
            const v = Number(localStorage.getItem(FSR1_LS_KEY));
            return Number.isFinite(v) && v >= 0.5 && v <= 1 ? v : null;
        } catch {
            return null;
        }
    };
    const fsr1: Fsr1Options | undefined = {
        renderScale: loadSavedScale() ?? 0.9,
        sharpness: 0.5,
    };

    const sampleStats = () => {
        const terrain = lod.getTerrainStats();
        const frameMs = sceneInstr.frameTimeCounter.lastSecAverage;
        // engine.gpuTimeInFrameForMainPass is a WebGPUPerfCounter (ns) armed by
        // enableGPUTimingMeasurements in EngineManager. Main (canvas) pass only —
        // terrain draw + post, NOT the TERRAIN compute passes.
        const wgpuMain = (
            engine as unknown as {
                gpuTimeInFrameForMainPass?: { counter: { lastSecAverage: number } };
            }
        ).gpuTimeInFrameForMainPass;
        const gpuMs = wgpuMain
            ? wgpuMain.counter.lastSecAverage / 1e6
            : engineInstr.gpuFrameTimeCounter.lastSecAverage / 1e6; // ns → ms
        const mem = perfMemory();
        return {
            fps: engine.getFps(),
            frameMs,
            gpuMs,
            // Scene render resolution: the engine backbuffer (px) and the hardware-scaling
            // level (1 = native; <1 supersamples, >1 downscales). This is the actual pixel
            // count the terrain/post passes shade, independent of CSS/display size.
            renderW: engine.getRenderWidth(),
            renderH: engine.getRenderHeight(),
            hwScale: engine.getHardwareScalingLevel(),
            // FSR1 internal render resolution: the scene is shaded at `renderScale` of the
            // backbuffer, then EASU+RCAS upscale to full res. 0 when FSR1 is disabled.
            fsr1Scale: fsr1 ? fsr1.renderScale : 0,
            fsr1W: fsr1 ? Math.round(engine.getRenderWidth() * fsr1.renderScale) : 0,
            fsr1H: fsr1 ? Math.round(engine.getRenderHeight() * fsr1.renderScale) : 0,
            drawCalls: sceneInstr.drawCallsCounter.current,
            activeIndices: scene.getActiveIndices(),
            // RAM: live JS heap in MB (-1 where the browser does not expose performance.memory).
            jsHeapMB: mem ? mem.usedJSHeapSize / 1048576 : -1,
            // OS GPU (whole device) from the nvidia-smi bridge; null if the bridge is not running
            // or the last sample is stale (> 3 s old). util %, VRAM MiB, clock MHz, power W.
            osGpu:
                osGpu && performance.now() - osGpu.recvMs < 3000 ? osGpu.data : null,
            terrain,
        };
    };

    const formatPerf = (s: ReturnType<typeof sampleStats>): string => {
        const f = (n: number, d = 1) => n.toFixed(d);
        return [
            `FPS ${Math.round(s.fps)}  frame ${f(s.frameMs)}ms`,
            `res ${s.renderW}x${s.renderH}${s.hwScale !== 1 ? `  hwScale ${f(s.hwScale, 2)}` : ''}`,
            s.fsr1Scale
                ? `fsr1 ${s.fsr1W}x${s.fsr1H} (${Math.round(s.fsr1Scale * 100)}%) → upscaled`
                : '',
            `gpu ${f(s.gpuMs)}ms (canvas)  draws ${s.drawCalls}`,
            s.osGpu
                ? `GPU ${f(s.osGpu.util, 0)}%  vram ${(s.osGpu.vramUsed / 1024).toFixed(1)}/${(s.osGpu.vramTotal / 1024).toFixed(0)}G  ${f(s.osGpu.clock, 0)}MHz ${f(s.osGpu.power, 0)}W`
                : `GPU% n/a (run scripts/gpu_hud_bridge.ps1)`,
            `ram ${s.jsHeapMB < 0 ? 'n/a' : f(s.jsHeapMB, 0) + 'MB'}  idx ${(s.activeIndices / 1000).toFixed(0)}k`,
            `terrain leaves ${s.terrain.leafCount}  verts ${s.terrain.vertexCount}`,
            `split/f ${s.terrain.splitsThisFrame}  merge/f ${s.terrain.mergesThisFrame}`,
            `classify ${f(s.terrain.classifyMs, 2)}ms  rebuild ${f(s.terrain.rebuildMs, 2)}ms`,
            // TERRAIN compute GPU time (the graph's compute task), split by bucket. 0 when the re-bake
            // gate is disengaged (still camera) or the timestamp-query feature is unavailable.
            `terrain topo ${f(s.terrain.terrainTopoMs, 2)} eval ${f(s.terrain.terrainEvalMs, 2)} compact ${f(s.terrain.terrainCompactMs, 2)}ms`,
            `atlas tiles ${s.terrain.terrainTilesUsed}/16384  mark ${f(s.terrain.terrainMarkStableMs, 2)}ms  alloc ${f(s.terrain.terrainAllocMs, 2)}ms  bake ${f(s.terrain.terrainBakeMs, 2)}ms`,
        ]
            .filter(Boolean)
            .join('\n');
    };

    disposables.addDomListener(window, 'keydown', (event) => {
        if (event.key.toLowerCase() !== 'p') return;
        const visible = gui.togglePerf();
        setCaptureEnabled(visible);
    });

    // Dev-only hook for deterministic headless capture (scripts/terrain_perf_capture.mjs).
    const tmpRenderTarget = new Vector3();
    const perfHook = {
        enableCapture: (on: boolean) => setCaptureEnabled(on),
        // Debug fragment perf-profiling mask read by TerrainSource each frame: bit0 skip slope normal,
        // bit1 skip df64 ground detail, bit2 skip crater rays. Toggle blocks, watch gpuMs.
        setPerfMask: (mask: number) => {
            (globalThis as unknown as { __terrainPerfMask?: number }).__terrainPerfMask = mask | 0;
        },
        /** Dev-only: pin TERRAIN topology (freeze the leaf set) so a fragment perf-mask sweep runs at a
         *  CONSTANT leaf count — the clean way to attribute per-block fragment cost. Converge the view
         *  FIRST, then freeze. Leaf-count variance confounded the old in-flight perfMask sweep. */
        setFreezeTopology: (on: boolean) => {
            (globalThis as unknown as { __terrainFreezeTopology?: boolean }).__terrainFreezeTopology =
                !!on;
        },
        /** Dev-only A/B: toggle the OPT-4 adaptive re-bake throttle (default on). Off = fixed base
         *  interval (the pre-OPT-4 behavior) so before/after compute cost can be measured directly. */
        setAdaptiveRebake: (on: boolean) => {
            (globalThis as unknown as { __terrainAdaptiveRebake?: boolean }).__terrainAdaptiveRebake =
                !!on;
        },
        getStats: () => sampleStats(),
        getPlanets: () => lod.getTerrainPlanetInfo(),
        setCameraDoublePos: (x: number, y: number, z: number) => {
            camera.doublepos.set(x, y, z);
            lod.resetNow();
        },
        /** Dev-only: drift the camera WITHOUT a LOD reset (mimics steady keyboard piloting, so the
         *  TERRAIN drift gate / re-bake throttle engages — unlike setCameraDoublePos which teleports). */
        nudgeCameraDoublePos: (dx: number, dy: number, dz: number) => {
            camera.doublepos.set(
                camera.doublepos.x + dx,
                camera.doublepos.y + dy,
                camera.doublepos.z + dz
            );
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
        /** Dev-only: force the engine render scale (1 = native, <1 = supersample). Lets a perf
         *  probe saturate the GPU at a controlled internal resolution to measure fragment cost. */
        setHardwareScaling: (level: number) => {
            scene.getEngine().setHardwareScalingLevel(Math.max(0.05, level));
        },
    };
    (window as unknown as { __world42Perf?: typeof perfHook }).__world42Perf = perfHook;
    disposables.add(() => {
        delete (window as unknown as { __world42Perf?: typeof perfHook }).__world42Perf;
    });

    // Deterministic camera-flight bench (dev-only): window.__world42Bench.run() replays a fixed
    // ground→orbit+yaw path with the planet spin frozen, for apples-to-apples optimization comparison.
    const benchPlanets: BenchPlanet[] = [];
    for (const system of loadedSystems.values()) {
        for (const [name, body] of system.bodies) {
            if (body.bodyType === 'star' || !body.node || !body.entity) continue;
            benchPlanets.push({
                key: `${system.systemId}:${name}`,
                node: body.node,
                center: body.entity.doublepos,
                radiusSim: body.radiusSim
            });
        }
    }
    // resetLod per flight: each bench flight re-bakes from a clean (un-converged) topology so the
    // convergence transient — hence the leaf-count trajectory — is identical run-to-run (else flight 2
    // inherits flight 1's converged tree). Confound B from the profiling bilan.
    installBenchFlight(
        scene,
        camera,
        benchPlanets,
        sampleStats,
        stars.map((s) => s.posWorldDouble),
        () => lod.resetNow()
    );
    disposables.add(() => {
        delete (window as unknown as { __world42Bench?: unknown }).__world42Bench;
    });

    // Physically-based starfield from the HYG catalog (replaces the static cubemap skybox).
    // The load is async and fire-and-forget: the scene shows a black background until the
    // binary is ready, then the GPU-driven billboards appear seamlessly.
    // The binary is self-hosted (public/stars/) — not on the CDN — so use a root-relative
    // URL that works in both dev (rspack serves public/) and prod (GitHub Pages at /World42/).
    const starCatalogUrl = '/stars/hyg_mag9.bin?v=1';
    loadStarCatalog(starCatalogUrl)
        .then((catalog) => {
            const starfield = createStarfieldRenderer(scene, catalog);
            disposables.add(() => starfield.dispose());

            // Drive atmospheric scintillation each frame.
            // atmosphereFactor = 0 for airless bodies (Moon) and in space; 1 at the surface
            // of a planet with an atmosphere. worldUp = normalised direction from planet
            // centre to camera, used to compute per-star airmass (horizon = more turbulence).
            const _worldUp = new Vector3();
            const _fallbackUp = new Vector3(0, 1, 0);
            const scintObserver = scene.onBeforeRenderObservable.add(() => {
                const nearest = pickNearestAtmosphere(camera.doublepos, atmospheres);
                if (!nearest) {
                    starfield.setAtmosphereState(0, _fallbackUp);
                    return;
                }
                camera.doublepos.subtractToRef(nearest.centerWorldDouble, _worldUp);
                const distKm = _worldUp.length();
                _worldUp.scaleInPlace(1 / distKm);  // normalise in-place
                const altKm = distKm - nearest.radiusKm;
                const factor = Math.max(0, 1 - altKm / nearest.params.heightKm);
                starfield.setAtmosphereState(factor, _worldUp);
            });
            disposables.addBabylonObserver(scene.onBeforeRenderObservable, scintObserver);
        })
        .catch((err: unknown) => {
            console.warn(
                '[World42] Star catalog unavailable — background will be black.\n' +
                '  Run: python tools/hyg_to_binary.py tools/hyg_v41.csv public/stars/hyg_mag8.bin\n' +
                `  URL attempted: ${starCatalogUrl}`,
                err
            );
        });

    // Analytic hard-floor ground collision: keep the camera above the TERRAIN/TERRAIN
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
        const infos = lod.getTerrainPlanetInfo();
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
        // Altitude above the ACTUAL terrain, not sea level: the nearest ground info gives the
        // analytic fbm height under the camera (same field the shader renders).
        let groundRadius = bestRadius;
        const terrainGround = lod.getTerrainGroundInfo();
        if (terrainGround && terrainGround.key === bestKey) groundRadius = terrainGround.groundRSim;
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

    // Render pipeline as a Frame Graph (replaces the imperative camera post-process stack:
    // DefaultRenderingPipeline + TAA pipeline + star post-process). The graph governs only the
    // render passes; TERRAIN compute / LOD / floating-origin keep running in their scene observables.
    const buildGraph = () =>
        attachFrameGraph(scene, camera, {
            stars,
            occluders,
            atmospheres,
            gui: gui.advancedTexture,
            // TERRAIN compute runs as a graph task (before the scene-render task). Until the graph is
            // built it is driven by the scheduler tick; onGraphReady hands ownership to the task.
            runCompute: lod.runTerrainCompute,
            onGraphReady: () => lod.setComputeOwnedByGraph(true),
            // FSR1 spatial upscaling (config hoisted above so the perf HUD can report the internal res).
            fsr1,
        });
    let fg = buildGraph();
    disposables.add(() => fg.dispose());

    // The graph sizes its render targets at build time, so changing the FSR1 render scale requires a
    // full rebuild. Gapless: hand the heavy compute back to the scheduler tick (which drives it whenever
    // the graph does not) while the new graph builds async, then onGraphReady reclaims ownership.
    const rebuildGraph = () => {
        lod.setComputeOwnedByGraph(false);
        fg.dispose();
        fg = buildGraph();
    };

    // Under a Frame Graph, scene.render() fires onBeforeRenderObservable but NOT
    // onBeforeActiveMeshesEvaluationObservable — yet OriginCamera's floating-origin re-centering is
    // registered there. Re-fire it once per frame so the camera integration still runs. Registered
    // LAST (after control / LOD tick / ground collision) so the fold happens after this-frame moves,
    // matching the non-frame-graph ordering.
    const foldObserver = scene.onBeforeRenderObservable.add(() => {
        scene.onBeforeActiveMeshesEvaluationObservable.notifyObservers(scene);
        scene.onAfterActiveMeshesEvaluationObservable.notifyObservers(scene);
    });
    disposables.addBabylonObserver(scene.onBeforeRenderObservable, foldObserver);

    const renderLoop = () => scene.render();
    engine.runRenderLoop(renderLoop);
    disposables.add(() => engine.stopRenderLoop(renderLoop));

    return {
        /** Current FSR1 internal render scale (fraction of the backbuffer the scene is shaded at). */
        fsr1RenderScale: fsr1 ? fsr1.renderScale : 1,
        /** Set the FSR1 render scale (0.5..1) and rebuild the graph; persists across reloads. */
        setFsr1RenderScale: (scale: number) => {
            if (!fsr1) return;
            const v = clampScale(scale);
            if (v === fsr1.renderScale) return;
            fsr1.renderScale = v;
            try {
                localStorage.setItem(FSR1_LS_KEY, String(v));
            } catch {
                // localStorage unavailable (private mode / SSR) — runtime change still applies.
            }
            rebuildGraph();
        },
    };
}
