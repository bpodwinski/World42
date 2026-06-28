import { Matrix, Quaternion, Vector3, type Scene, type TransformNode } from '@babylonjs/core';
import type { OriginCamera } from '../core/camera/camera_manager';
import { ScaleManager } from '../core/scale/scale_manager';

/**
 * Deterministic camera-flight bench (dev-only). Replays the SAME ground→orbit trajectory every run so
 * optimizations can be compared apples-to-apples. Exposed as `window.__world42Bench`.
 *
 * Determinism: the camera pose is a pure function of the FRAME INDEX (not wall-clock), one keyframe per
 * rendered frame, so the path is identical regardless of fps. The target planet's spin is FROZEN for the
 * duration (rotation.y re-imposed each frame), so the relief under the path does not drift between runs.
 * The pose observer is registered FIRST (insertFirst) so visibility cull + the OCBT compute + the render
 * all see the bench pose the same frame. Per-frame metrics are captured via the injected stats sampler;
 * whole-GPU power is sampled externally (nvidia-smi) by scripts/bench_flight.mjs and aligned by timestamp.
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
    cbt: {
        leafCount: number;
        ocbtTopoMs: number;
        ocbtEvalMs: number;
        ocbtCompactMs: number;
    };
};

type BenchFrame = {
    i: number;
    t: number; // performance.now() at capture (for nvidia-smi alignment)
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
    /** Total rendered frames to replay (default 720 ≈ 12 s at 60 fps). */
    frames?: number;
    /** Target planet key suffix (e.g. "Moon"); default = nearest planet to the camera at call time. */
    planet?: string;
    /** Fraction of the run spent skimming the ground before the climb (default 0.45). */
    groundFrac?: number;
};

const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

export function installBenchFlight(
    scene: Scene,
    camera: OriginCamera,
    planets: BenchPlanet[],
    sampleStats: () => BenchFrameSample
): void {
    let running = false;

    const api = {
        isRunning: () => running,

        /** Replay the deterministic ground→orbit+yaw flight; resolves with the per-frame metric log. */
        run: (opts: BenchRunOptions = {}): Promise<{ meta: object; frames: BenchFrame[] }> => {
            if (running) return Promise.reject(new Error('bench already running'));
            if (!planets.length) return Promise.reject(new Error('no bench planets'));

            const N = Math.max(60, Math.floor(opts.frames ?? 720));
            const groundFrac = Math.min(0.9, Math.max(0.1, opts.groundFrac ?? 0.45));

            // Pick the target planet: by key suffix, else nearest to the camera now.
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

            // Freeze spin: capture rotation.y, re-impose it each frame (the catalog spin observer ran
            // earlier this frame; we override it). Capture the frozen world rotation for local→world.
            const frozenYaw = node.rotation.y;
            node.rotation.y = frozenYaw;
            node.computeWorldMatrix(true);
            const Rw = new Matrix();
            node.getWorldMatrix().getRotationMatrixToRef(Rw);

            // Fixed planet-local path basis (constant while frozen): a non-polar ground anchor + a
            // tangent travel direction + the great-circle binormal.
            const a = new Vector3(1, 0.5, 0.25).normalize();
            const t = Vector3.Cross(a, Vector3.Up()).normalize(); // travel direction (⊥ a)

            // Path scalars per normalized param u∈[0,1].
            const ARC_GROUND = 0.012; // rad swept along the surface while skimming (~21 km on the Moon)
            const ARC_CLIMB = 0.008; // extra arc during the climb
            const LOOK_AHEAD = 0.03; // grazing-horizon look-ahead (rad)
            const ALT_GROUND = 0.03; // km (30 m)
            const ALT_TOP = 2 * R; // final distance = R + 2R = 3R (matches the xR waypoint convention)
            const YAW_AMP = 0.45; // rad — slow look sweep to exercise frustum cull / mouse-look wake

            const dirAt = (theta: number, out: Vector3): Vector3 => {
                // Great-circle: a*cos + t*sin (unit).
                out.set(
                    a.x * Math.cos(theta) + t.x * Math.sin(theta),
                    a.y * Math.cos(theta) + t.y * Math.sin(theta),
                    a.z * Math.cos(theta) + t.z * Math.sin(theta)
                );
                return out.normalize();
            };

            const dirL = new Vector3();
            const aheadL = new Vector3();
            const camLocal = new Vector3();
            const tgtLocal = new Vector3();
            const camWorld = new Vector3();
            const tgtWorld = new Vector3();
            const lookDir = new Vector3();
            const renderTarget = new Vector3();
            const yawQ = new Quaternion();

            const frames: BenchFrame[] = [];
            let i = 0;

            return new Promise((resolve) => {
                const poseFor = (idx: number): 'ground' | 'climb' => {
                    const u = idx / (N - 1);
                    const climbing = u >= groundFrac;
                    const cu = climbing ? (u - groundFrac) / (1 - groundFrac) : 0; // climb param 0..1

                    const theta =
                        ARC_GROUND * smoothstep(0, groundFrac, u) + ARC_CLIMB * (climbing ? cu : 0);
                    const altKm = climbing
                        ? ALT_GROUND + (ALT_TOP - ALT_GROUND) * smoothstep(0, 1, cu)
                        : ALT_GROUND;

                    dirAt(theta, dirL);
                    camLocal.copyFrom(dirL).scaleInPlace(R + altKm);

                    // Look target: grazing-horizon point ahead at ground; blend toward nadir (center) on climb.
                    dirAt(theta + LOOK_AHEAD, aheadL);
                    aheadL.scaleInPlace(R); // surface point ahead
                    const nadirBlend = climbing ? smoothstep(0, 1, cu) : 0;
                    tgtLocal.copyFrom(aheadL).scaleInPlace(1 - nadirBlend); // → (0,0,0)=center as blend→1

                    // Local → world (frozen rotation).
                    Vector3.TransformCoordinatesToRef(camLocal, Rw, camWorld);
                    camWorld.addInPlace(C);
                    Vector3.TransformCoordinatesToRef(tgtLocal, Rw, tgtWorld);
                    tgtWorld.addInPlace(C);

                    // Yaw the look direction around the radial (world up) axis — steady sweep both ways.
                    lookDir.copyFrom(tgtWorld).subtractInPlace(camWorld);
                    const yaw = YAW_AMP * Math.sin(u * Math.PI * 2);
                    Vector3.TransformNormalToRef(dirL, Rw, renderTarget); // reuse: world radial up
                    Quaternion.RotationAxisToRef(renderTarget.normalize(), yaw, yawQ);
                    lookDir.rotateByQuaternionToRef(yawQ, lookDir);

                    // Impose absolute pose: doublepos = path point, zero render-space drift, set look target.
                    camera.doublepos.copyFrom(camWorld);
                    camera.position.set(0, 0, 0);
                    renderTarget.copyFrom(lookDir); // render-space target (camera sits at render origin)
                    camera.setTarget(renderTarget);
                    return climbing ? 'climb' : 'ground';
                };

                const observer = scene.onBeforeRenderObservable.add(
                    () => {
                        node.rotation.y = frozenYaw; // re-freeze spin (override the catalog observer)
                        const phase = poseFor(i);
                        // Capture LAST frame's metrics (this frame's pose drives next frame's measured cost,
                        // but the smoothed counters make the 1-frame offset immaterial for aggregation).
                        const s = sampleStats();
                        const u = i / (N - 1);
                        const altKm = phase === 'climb'
                            ? ScaleManager.toRealUnits(
                                Math.max(0, camera.doublepos.subtract(C).length() - R))
                            : ALT_GROUND;
                        frames.push({
                            i,
                            t: Date.now(), // wall clock — aligns with the external nvidia-smi sampler
                            phase,
                            altKm,
                            leaves: s.cbt.leafCount,
                            draws: s.drawCalls,
                            frameMs: s.frameMs,
                            gpuMs: s.gpuMs,
                            topoMs: s.cbt.ocbtTopoMs,
                            evalMs: s.cbt.ocbtEvalMs,
                            compactMs: s.cbt.ocbtCompactMs
                        });
                        i++;
                        if (i >= N) {
                            scene.onBeforeRenderObservable.remove(observer);
                            node.rotation.y = frozenYaw; // leave the planet where it started (spin resumes)
                            running = false;
                            resolve({
                                meta: {
                                    planet: target.key,
                                    radiusSim: R,
                                    frames: N,
                                    groundFrac,
                                    u: `0..1`
                                },
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
