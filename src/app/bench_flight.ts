import { Matrix, type Observer, Vector3, type Scene, type TransformNode } from '@babylonjs/core';
import type { OriginCamera } from '../core/camera/camera_manager';
import { ScaleManager } from '../core/scale/scale_manager';

/**
 * Deterministic camera-flight bench (dev-only). Replays the SAME path every run so optimizations can be
 * compared apples-to-apples. Exposed as `window.__world42Bench`.
 *
 * Path: starts at the planet's NORTH POLE, does a short ground roll RECEDING from the sun (camera looks
 * back at the star), then climbs PROGRESSIVELY like an airplane (gentle continuous ascent that levels off
 * at a low cruise orbit), rotating the view from the star down toward the planet (nadir) during the climb
 * so you can eyeball the frustum cull as the body re-frames.
 *
 * Determinism: the camera pose is a pure function of the FRAME INDEX (not wall-clock), one keyframe per
 * rendered frame, so the path is identical regardless of fps. The target planet's spin is FROZEN for the
 * duration (rotation.y re-imposed each frame). The pose observer is registered FIRST (insertFirst) so
 * cull + compute + render all see the bench pose the same frame. Each run also RESETS TERRAIN topology
 * (resetLod) up front, so the convergence transient — and thus the leaf-count trajectory — is identical
 * run-to-run (no state leak from a previous flight). Per-frame metrics come from the injected stats
 * sampler; whole-GPU power is sampled externally (nvidia-smi) by scripts/bench_flight.mjs.
 */

export type BenchPlanet = {
    key: string;
    node: TransformNode; // renderParent (rotation.y = spin)
    center: Vector3; // entity.doublepos (WorldDouble, live ref)
    radiusSim: number;
};

export type BenchFrameSample = {
    fps: number;
    frameMs: number;
    gpuMs: number;
    drawCalls: number;
    terrain: { leafCount: number; terrainTopoMs: number; terrainEvalMs: number; terrainCompactMs: number };
};

type BenchFrame = {
    i: number;
    t: number;
    phase: 'ground' | 'climb';
    altKm: number;
    leaves: number;
    draws: number;
    frameMs: number;
    gpuMs: number;
    topoMs: number;
    evalMs: number;
    compactMs: number;
};

export type BenchRunOptions = {
    /** Total rendered frames to replay (default 2000 ≈ 33 s at 60 fps). */
    frames?: number;
    /** Target planet key suffix (e.g. "Moon"); default = nearest planet to the camera at call time. */
    planet?: string;
    /** Fraction of the run spent on the ground roll before the airplane climb starts (default 0.25). */
    groundFrac?: number;
    /** Top altitude as a multiple of the planet radius (default 1 → final distance 2×R, a low slow climb). */
    topAltR?: number;
    /** Lock the internal render resolution for the run so profiling is comparable (default 1920×1080). */
    renderWidth?: number;
    renderHeight?: number;
    /** Cap the bench to this frame rate (default 60) so the deterministic test runs at the SAME rate on
     *  any display (a 120 Hz screen would otherwise play the path twice as fast). Ignored if uncapped. */
    fpsCap?: number;
    /** Fixed planet spin phase (rad) frozen for the run (default 0) — makes the terrain under the path
     *  identical on every run, independent of when the bench is launched. */
    spinPhase?: number;
    /** Uncap the frame rate (swap the rAF loop for a non-rAF one) so the GPU runs flat-out (default FALSE:
     *  it makes the browser unresponsive — flat-out on the main thread. Only exceeds the display refresh
     *  when Chrome was launched with --disable-gpu-vsync). Power deltas are measurable WITHOUT this. */
    uncapped?: boolean;
};

export type BenchGrazingOptions = {
    /** Target planet key suffix (e.g. "Moon"); default = nearest planet to the camera. */
    planet?: string;
    /** Camera altitude above the surface (km, default 3) — nadir view of a raking-lit terrain patch. */
    altKm?: number;
    /** Sun elevation above the local horizon (deg, default 5 = grazing light → long shadows + bright
     *  sun-facing slopes → maximal per-pixel normal→luminance sensitivity = worst-case grain). */
    sunElevDeg?: number;
    /** View tilt away from straight-down toward the sun (deg, default 0 = pure nadir). The terrain fills
     *  the frame either way; a small tilt brings the long shadows more side-on. */
    pitchDeg?: number;
    /** Frozen planet spin phase (rad, default 0) so the terrain under the view is identical every run. */
    spinPhase?: number;
};

const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

export function installBenchFlight(
    scene: Scene,
    camera: OriginCamera,
    planets: BenchPlanet[],
    sampleStats: () => BenchFrameSample,
    starPositions: Vector3[] = [],
    resetLod: () => void = () => {}
): void {
    let running = false;
    let poseHold: Observer<Scene> | null = null;

    const api = {
        isRunning: () => running,

        /** Pose a DETERMINISTIC grazing-sun ground view and HOLD it (re-imposed each frame) so a grain
         *  probe can screenshot it at different resolutions / perf-masks. Construction: a surface point
         *  whose local horizon puts the sun at `sunElevDeg` (raking light), camera at `altKm`, looking
         *  along the surface toward the sub-solar direction — the worst case for per-pixel normal grain.
         *  Spin is frozen to `spinPhase`. Call releasePose() to stop. */
        poseGrazing: (opts: BenchGrazingOptions = {}): object => {
            if (poseHold) {
                scene.onBeforeRenderObservable.remove(poseHold);
                poseHold = null;
            }
            // Target planet: by key suffix, else nearest to the camera now.
            let target = planets[0];
            if (opts.planet) {
                const m = planets.find((p) =>
                    p.key.toLowerCase().endsWith(opts.planet!.toLowerCase())
                );
                if (m) target = m;
            } else {
                let best = Infinity;
                for (const p of planets) {
                    const d = Vector3.DistanceSquared(camera.doublepos, p.center);
                    if (d < best) {
                        best = d;
                        target = p;
                    }
                }
            }
            const C = target.center.clone();
            const R = target.radiusSim;
            const node = target.node;
            const benchYaw = opts.spinPhase ?? 0;
            node.rotation.y = benchYaw;
            node.computeWorldMatrix(true);

            // Nearest star → world-space sun direction (planet center → star).
            let sunDir = new Vector3(1, 0, 0);
            let bestStar = Infinity;
            for (const s of starPositions) {
                const d = Vector3.DistanceSquared(s, C);
                if (d < bestStar) {
                    bestStar = d;
                    sunDir = s.subtract(C).normalize();
                }
            }

            // Surface point P whose local horizon puts the sun at `sunElevDeg`: a normal nP with
            // dot(nP, sun) = sin(elev). r is any axis ⊥ sun; nP tilts from r toward sun by the elevation.
            const altKm = Math.max(0, opts.altKm ?? 3);
            const elev = ((opts.sunElevDeg ?? 5) * Math.PI) / 180;
            const ref =
                Math.abs(sunDir.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
            const r = Vector3.Cross(sunDir, ref).normalize();
            const nP = sunDir
                .scale(Math.sin(elev))
                .add(r.scale(Math.cos(elev)))
                .normalize();
            const camW = C.add(nP.scale(R + altKm));
            // Sun-azimuth tangent (screen-up direction). View is NADIR (straight down at the raking-lit
            // terrain so it fills the frame), optionally tilted toward the sun by pitchDeg.
            const lookTangent = sunDir
                .subtract(nP.scale(Vector3.Dot(sunDir, nP)))
                .normalize();
            const tilt = ((opts.pitchDeg ?? 0) * Math.PI) / 180;
            const lookDir = nP
                .scale(-Math.cos(tilt))
                .add(lookTangent.scale(Math.sin(tilt)))
                .normalize();
            const renderTarget = new Vector3();

            const apply = (): void => {
                node.rotation.y = benchYaw;
                camera.doublepos.copyFrom(camW);
                camera.position.set(0, 0, 0);
                // Nadir view: screen-up = sun azimuth (so shadows fall "downward" in frame).
                camera.upVector.copyFrom(lookTangent);
                renderTarget.copyFrom(lookDir); // render-space target (camera at render origin)
                camera.setTarget(renderTarget);
            };
            apply();
            poseHold = scene.onBeforeRenderObservable.add(apply, undefined, true);
            return {
                planet: target.key,
                altKm,
                sunElevDeg: Math.asin(Vector3.Dot(nP, sunDir)) * (180 / Math.PI),
                radiusSim: R,
                camDistToCenter: Vector3.Distance(camW, C)
            };
        },

        /** Stop holding the grazing pose (the camera/spin resume normal control). */
        releasePose: (): void => {
            if (poseHold) {
                scene.onBeforeRenderObservable.remove(poseHold);
                poseHold = null;
            }
        },

        /** Replay the deterministic north-pole → low-orbit flight (star-locked); resolves with the log. */
        run: (opts: BenchRunOptions = {}): Promise<{ meta: object; frames: BenchFrame[] }> => {
            if (running) return Promise.reject(new Error('bench already running'));
            if (!planets.length) return Promise.reject(new Error('no bench planets'));

            const N = Math.max(60, Math.floor(opts.frames ?? 2000));
            const groundFrac = Math.min(0.9, Math.max(0.05, opts.groundFrac ?? 0.25));
            const topAltR = Math.max(0.1, opts.topAltR ?? 1);

            // Lock the internal render resolution to 1080p for the whole run so the fragment cost (and
            // thus the GPU power/util) is comparable across runs/machines regardless of window size. The
            // CSS canvas keeps its size (the 1080p buffer just stretches to fit); restored at the end.
            const engine = scene.getEngine();
            const lockW = Math.max(64, Math.floor(opts.renderWidth ?? 1920));
            const lockH = Math.max(64, Math.floor(opts.renderHeight ?? 1080));
            engine.setSize(lockW, lockH, true);

            // Render-loop control for the run. DEFAULT: a rAF loop TIME-GATED to fpsCap (60) so the test is
            // deterministic on any display (a 120 Hz screen would otherwise play the path twice as fast) and
            // stays smooth. uncapped:true → a non-rAF MessageChannel loop running flat-out (GPU saturated)
            // but the browser goes UNRESPONSIVE, so it is opt-in. beginFrame/endFrame wrap scene.render()
            // exactly like Babylon's own loop — endFrame PRESENTS the swapchain AND resets the GPU-timestamp
            // query pool (without it: timestamp "index out of range" + "Destroyed texture used in a submit").
            const uncapped = opts.uncapped ?? false;
            const fpsCap = Math.max(1, opts.fpsCap ?? 60);
            let restoreLoop: () => void = () => {};
            engine.stopRenderLoop();
            if (uncapped) {
                const mc = new MessageChannel();
                let stopped = false;
                mc.port1.onmessage = () => {
                    if (stopped) return;
                    engine.beginFrame();
                    scene.render();
                    engine.endFrame();
                    mc.port2.postMessage(0);
                };
                mc.port2.postMessage(0); // kick off the loop
                restoreLoop = () => { stopped = true; engine.runRenderLoop(() => scene.render()); };
            } else {
                const targetMs = 1000 / fpsCap;
                let last = 0;
                let raf = 0;
                const loop = (now: number): void => {
                    raf = requestAnimationFrame(loop);
                    if (now - last < targetMs - 1) return; // gate to fpsCap (skip the extra refresh ticks)
                    last = now;
                    engine.beginFrame();
                    scene.render();
                    engine.endFrame();
                };
                raf = requestAnimationFrame(loop);
                restoreLoop = () => { cancelAnimationFrame(raf); engine.runRenderLoop(() => scene.render()); };
            }

            // Target planet: by key suffix, else nearest to the camera now.
            let target = planets[0];
            if (opts.planet) {
                const m = planets.find((p) => p.key.toLowerCase().endsWith(opts.planet!.toLowerCase()));
                if (m) target = m;
            } else {
                let best = Infinity;
                for (const p of planets) {
                    const d = Vector3.DistanceSquared(camera.doublepos, p.center);
                    if (d < best) { best = d; target = p; }
                }
            }

            const C = target.center.clone(); // planet center (static body → constant)
            const R = target.radiusSim;
            const node = target.node;

            // Nearest star to the planet → the camera locks onto it (WorldDouble; null = horizon fallback).
            let starPos: Vector3 | null = null;
            let bestStar = Infinity;
            for (const s of starPositions) {
                const d = Vector3.DistanceSquared(s, C);
                if (d < bestStar) { bestStar = d; starPos = s; }
            }

            // Freeze spin to a FIXED phase (default 0) — NOT the current phase — so the terrain under the
            // path is identical on every run regardless of when the bench is launched (the catalog spin
            // observer has been advancing rotation.y since load). Re-imposed each frame; the ORIGINAL phase
            // is restored at the end so the user's continued view is not disturbed.
            const originalYaw = node.rotation.y;
            const benchYaw = opts.spinPhase ?? 0;
            node.rotation.y = benchYaw;
            node.computeWorldMatrix(true);
            const Rw = new Matrix();
            node.getWorldMatrix().getRotationMatrixToRef(Rw);

            // Path basis (planet-local, constant while frozen): START AT THE NORTH POLE (+Y). Travel heads
            // AWAY FROM THE SUN — `t` = MINUS the star direction projected onto the pole's tangent plane —
            // so the camera RECEDES from the sub-solar point while LOOKING BACK at the star (no strafe).
            const a = new Vector3(0, 1, 0);
            let t: Vector3;
            if (starPos) {
                const RwInv = new Matrix();
                Rw.invertToRef(RwInv);
                const sunLocal = Vector3.TransformNormalToRef(
                    starPos.subtract(C).normalize(),
                    RwInv,
                    new Vector3()
                );
                // -(horizontal component of the sun dir): the surface tangent pointing AWAY from the sun.
                const tang = a.scale(Vector3.Dot(sunLocal, a)).subtractInPlace(sunLocal);
                t = tang.lengthSquared() > 1e-6
                    ? tang.normalize()
                    : Vector3.Cross(a, new Vector3(1, 0, 0)).normalize();
            } else {
                const ref = Math.abs(a.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
                t = Vector3.Cross(a, ref).normalize();
            }

            const ARC_GROUND = 0.012; // rad swept along the surface while skimming
            const ARC_CLIMB = 0.004;
            const ALT_GROUND = 0.03; // km (30 m)
            const ALT_TOP = topAltR * R; // final distance = R + topAltR*R

            const dirL = new Vector3();
            const camLocal = new Vector3();
            const camWorld = new Vector3();
            const tgtWorld = new Vector3();
            const lookDir = new Vector3();
            const renderTarget = new Vector3();

            const dirAt = (theta: number, out: Vector3): Vector3 => {
                out.set(
                    a.x * Math.cos(theta) + t.x * Math.sin(theta),
                    a.y * Math.cos(theta) + t.y * Math.sin(theta),
                    a.z * Math.cos(theta) + t.z * Math.sin(theta)
                );
                return out.normalize();
            };

            const frames: BenchFrame[] = [];
            let i = 0;

            // Confound B (profiling bilan): re-bake topology from scratch so EVERY flight starts from
            // the same un-converged state and replays an identical leaf-count trajectory. Without this,
            // back-to-back flights (--repeat) inherit the previous flight's converged tree → different
            // transient → noisy power/leaf deltas mistaken for optimization signal.
            resetLod();

            return new Promise((resolve) => {
                const poseFor = (idx: number): 'ground' | 'climb' => {
                    const u = idx / (N - 1);
                    const climbing = u >= groundFrac;
                    const cu = climbing ? (u - groundFrac) / (1 - groundFrac) : 0;

                    const theta = ARC_GROUND * smoothstep(0, groundFrac, u) + ARC_CLIMB * cu;
                    // LOG/exponential climb: equal time per altitude OCTAVE across the huge 30m→~1000s-km
                    // range, so the ascent stays smooth (a linear ramp blows through the low altitudes in a
                    // few frames = abrupt). smoothstep(cu) eases the takeoff + levels off at cruise on top.
                    const climb01 = smoothstep(0, 1, cu); // 0 on the ground roll, 1 at cruise
                    const altKm = ALT_GROUND * Math.pow(ALT_TOP / ALT_GROUND, climb01);

                    dirAt(theta, dirL);
                    camLocal.copyFrom(dirL).scaleInPlace(R + altKm);
                    Vector3.TransformCoordinatesToRef(camLocal, Rw, camWorld);
                    camWorld.addInPlace(C);

                    // GROUND: lock onto the star (fixed sun at the start). CLIMB: rotate the view from the
                    // star toward the PLANET (nadir, planet center) so the rising camera frames the whole
                    // body — lets you eyeball the frustum cull / prefetch as terrain leaves & re-enters view.
                    if (starPos) {
                        lookDir.copyFrom(starPos).subtractInPlace(camWorld).normalize();
                        if (climbing) {
                            tgtWorld.copyFrom(C).subtractInPlace(camWorld).normalize(); // nadir
                            const b = smoothstep(0, 1, cu);
                            lookDir.scaleInPlace(1 - b).addInPlace(tgtWorld.scaleInPlace(b)).normalize();
                        }
                    } else {
                        // No star: look at the planet center the whole time.
                        lookDir.copyFrom(C).subtractInPlace(camWorld).normalize();
                    }

                    camera.doublepos.copyFrom(camWorld);
                    camera.position.set(0, 0, 0);
                    renderTarget.copyFrom(lookDir); // render-space target (camera at render origin)
                    camera.setTarget(renderTarget);
                    return climbing ? 'climb' : 'ground';
                };

                const observer = scene.onBeforeRenderObservable.add(
                    () => {
                        node.rotation.y = benchYaw; // re-freeze to the FIXED bench phase
                        const phase = poseFor(i);
                        const s = sampleStats();
                        const altKm = phase === 'climb'
                            ? ScaleManager.toRealUnits(Math.max(0, camera.doublepos.subtract(C).length() - R))
                            : ALT_GROUND;
                        frames.push({
                            i,
                            t: Date.now(),
                            phase,
                            altKm,
                            leaves: s.terrain.leafCount,
                            draws: s.drawCalls,
                            frameMs: s.frameMs,
                            gpuMs: s.gpuMs,
                            topoMs: s.terrain.terrainTopoMs,
                            evalMs: s.terrain.terrainEvalMs,
                            compactMs: s.terrain.terrainCompactMs
                        });
                        i++;
                        if (i >= N) {
                            scene.onBeforeRenderObservable.remove(observer);
                            node.rotation.y = originalYaw; // restore the original phase (spin resumes from there)
                            restoreLoop(); // back to the rAF render loop
                            engine.resize(); // restore the window-driven render resolution
                            running = false;
                            resolve({
                                meta: { planet: target.key, radiusSim: R, frames: N, groundFrac, topAltR, starLocked: !!starPos },
                                frames
                            });
                        }
                    },
                    undefined,
                    true // insertFirst: set the pose before visibility cull / compute / render
                );
                running = true;
            });
        }
    };

    (window as unknown as { __world42Bench?: typeof api }).__world42Bench = api;
}
