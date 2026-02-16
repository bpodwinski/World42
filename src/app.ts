import {
    Engine,
    Scene,
    Vector3,
    WebGPUEngine,
} from "@babylonjs/core";
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";
import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";

import { PostProcess } from "./core/render/postprocess_manager";
import { OriginCamera } from "./core/camera/camera_manager";
import { MouseSteerControlManager } from "./core/control/mouse_steer_control_manager";
import { GuiManager } from "./core/gui/gui_manager";
import planetsJson from "./game_world/stellar_system/data.json";
import { teleportToEntity } from "./core/camera/teleport_entity";
import { ScaleManager } from "./core/scale/scale_manager";
import { LodScheduler } from "./systems/lod/lod_scheduler";
import {
    attachStarRayMarchingPostProcess,
    type StarGlowSource,
} from "./core/render/star_raymarch_postprocess";
import { createBaseScene } from "./core/render/create_scene";
import {
    buildStellarSystemPlanetsCDLOD,
    loadStellarSystemRuntime,
} from "./game_world/stellar_system/stellar_system_runtime";
import { TerrainShadowSystem } from "./game_objects/planets/rocky_planet/terrain_shadow";
import { createSkybox } from "./core/render/skybox_factory";

import { LeapfrogNBodyIntegrator } from "./systems/orbit/LeapfrogNBodyIntegrator";
import { OrbitSystem } from "./systems/orbit/OrbitSystem";
import type { OrbitBodyState } from "./systems/orbit/types";

export class FloatingCameraScene {
    public static async CreateScene(
        engine: Engine | WebGPUEngine,
        canvas: HTMLCanvasElement
    ): Promise<Scene> {
        const scene = createBaseScene(engine);

        createSkybox(scene, {
            url: `${process.env.ASSETS_URL}/skybox`,
            size: 1000,
            renderingGroupId: 0,
        });

        // Load stellar system
        const runtime = await loadStellarSystemRuntime(scene, planetsJson, {
            preferredSystemId: "DebugSystem",
            preferredBodyName: "DebugPlanet1",
        });

        const loadedSystems = runtime.loadedSystems;
        const body = runtime.spawnBody;

        // GUI
        const gui = new GuiManager(scene);
        gui.setMouseCrosshairVisible(true);

        // Camera
        const planetTargetWorldDouble = body.positionWorldDouble.clone();
        planetTargetWorldDouble.y += body.diameter * 0.52;

        const camera = new OriginCamera("camera_player", planetTargetWorldDouble, scene);
        camera.debugMode = true;
        camera.minZ = 0.001;
        camera.maxZ = 1_000_000;
        camera.fov = 1.2;
        camera.applyGravity = false;
        camera.inertia = 0;
        camera.inputs.clear();
        camera.checkCollisions = false;

        const tmpTargetRender = new Vector3();
        camera.toRenderSpace(body.positionWorldDouble, tmpTargetRender);
        camera.setTarget(tmpTargetRender);

        const control = new MouseSteerControlManager(
            camera,
            scene,
            canvas,
            camera.camCollider,
            {}
        );
        control.gui = gui;

        // CDLOD
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

        // -------------------------------------------------------------------------
        // ORBITS / GRAVITY (WorldDouble only)
        // -------------------------------------------------------------------------

        // Conversion: sim-distance -> km (tu l'utilises déjà pour les distances)
        // Donc 1 simUnit correspond à ScaleManager.toRealUnits(1) km.
        const metersPerSimUnit = ScaleManager.toRealUnits(1) * 1000;
        const G_SI = 6.67430e-11; // m^3 kg^-1 s^-2
        const Gsim = G_SI / (metersPerSimUnit * metersPerSimUnit * metersPerSimUnit); // sim^3 kg^-1 s^-2

        const orbitBodies: OrbitBodyState[] = [];
        let starId: string | null = null;

        for (const [sysId, sys] of loadedSystems) {
            for (const b of sys.bodies.values()) {
                const id = `${sysId}:${b.name}`;

                const entity = (b as any).entity; // FloatingEntity
                if (!entity) continue;

                const isStar = b.bodyType === "star";

                const massKg = (b as any).massKg ?? 0;

                // Source de vérité WorldDouble = entity.doublepos
                const posWorldDouble = entity.doublepos;
                const velWorldDouble =
                    entity.doublevel ?? (entity.doublevel = new Vector3(0, 0, 0));

                orbitBodies.push({
                    id,
                    massKg,
                    posWorldDouble,
                    velWorldDouble,
                    isFixed: isStar,
                    affectsGravity: isStar,
                });

                console.table(
                    orbitBodies.map(b => ({
                        id: b.id,
                        massKg: b.massKg,
                        isFixed: !!b.isFixed,
                        affectsGravity: b.affectsGravity !== false,
                        vSim: b.velWorldDouble.length()
                    }))
                );

                if (isStar && massKg > 0 && !starId) starId = id;
            }
        }

        const star = starId ? orbitBodies.find(b => b.id === starId) ?? null : null;

        // Log init (pour diagnostiquer masses)
        console.log(
            "[orbit:init]",
            "bodies=", orbitBodies.length,
            "star=", star?.id ?? "NONE",
            "Mstar=", star?.massKg ?? 0,
            "metersPerSimUnit=", metersPerSimUnit,
            "Gsim=", Gsim
        );

        {
            const top = [...orbitBodies]
                .sort((a, b) => (b.massKg ?? 0) - (a.massKg ?? 0))
                .slice(0, 5)
                .map(b => ({ id: b.id, massKg: b.massKg, isFixed: b.isFixed, affectsGravity: b.affectsGravity }));
            console.table(top);

            const missing = orbitBodies.filter(b => (b.massKg ?? 0) <= 0).slice(0, 10).map(b => b.id);
            if (missing.length) console.warn("[orbit:init] massKg<=0 (first):", missing);
        }

        // Init vitesses circulaires (si star OK)
        if (star && star.massKg > 0) {
            const up = Vector3.Up();
            for (const p of orbitBodies) {
                if (p.isFixed) continue;
                if ((p.massKg ?? 0) <= 0) continue;
                if (p.velWorldDouble.lengthSquared() > 0) continue;

                const rVec = p.posWorldDouble.subtract(star.posWorldDouble);
                const r = rVec.length();
                if (r <= 0) continue;

                let tangent = Vector3.Cross(up, rVec);
                if (tangent.lengthSquared() < 1e-12) tangent = Vector3.Cross(Vector3.Right(), rVec);
                tangent.normalize();

                const v = Math.sqrt((Gsim * star.massKg) / r); // simUnits/s
                p.velWorldDouble.copyFrom(tangent.scale(v));
            }
        }

        const orbitIntegrator = new LeapfrogNBodyIntegrator(Gsim, 1e-3);
        const orbitSystem = new OrbitSystem(orbitBodies, orbitIntegrator, 1);

        // Debug orbit (1/sec)
        let lastOrbitLog = performance.now();
        const lastAngleById = new Map<string, number>();

        // IMPORTANT: insertFirst pour exécuter avant le LOD
        scene.onBeforeRenderObservable.add(() => {
            const dt = scene.getEngine().getDeltaTime() / 1000;

            orbitSystem.tick(dt);

            const now = performance.now();
            if (now - lastOrbitLog < 1000) return;
            const dtLog = (now - lastOrbitLog) / 1000;
            lastOrbitLog = now;

            if (!star || star.massKg <= 0) {
                console.warn("[orbit] no star mass => no orbit physics");
                return;
            }

            // observe 1 planète non-fixed
            const p = orbitBodies.find(b => !b.isFixed && (b.massKg ?? 0) > 0) ?? null;
            if (!p) {
                console.warn("[orbit] no non-fixed planet to observe (you fixed the player planet)");
                return;
            }

            const rVec = p.posWorldDouble.subtract(star.posWorldDouble);
            const rSim = rVec.length();
            const rKm = ScaleManager.toRealUnits(rSim);

            const vSim = p.velWorldDouble.length();
            const vMS = ScaleManager.simSpeedToMetersPerSec(vSim);

            const ang = Math.atan2(rVec.z, rVec.x);
            const prev = lastAngleById.get(p.id);
            lastAngleById.set(p.id, ang);

            let dAngDegPerSec = 0;
            if (prev !== undefined) {
                let d = ang - prev;
                if (d > Math.PI) d -= 2 * Math.PI;
                if (d < -Math.PI) d += 2 * Math.PI;
                dAngDegPerSec = (d * (180 / Math.PI)) / Math.max(dtLog, 1e-6);
            }

            console.log(
                `[orbit] ${p.id} r=${rKm.toFixed(2)} km v=${vMS.toFixed(2)} m/s dθ=${dAngDegPerSec.toFixed(4)}°/s`
            );
        }, undefined, true);

        lod.start();

        // Shadows
        const shadowSystem = new TerrainShadowSystem(
            {
                scene,
                engine,
                camera,
                planets: Array.from(mergedCDLOD.values()),
            }
        );

        const disposeShadows = shadowSystem.attach();
        scene.onDisposeObservable.add(() => disposeShadows());

        // Star postprocess sources
        const stars: StarGlowSource[] = [];
        for (const sys of loadedSystems.values()) {
            for (const b of sys.bodies.values()) {
                if (b.bodyType !== "star") continue;
                const light = (b as any).starLight;
                stars.push({
                    posWorldDouble: b.positionWorldDouble,
                    radius: b.diameter * 0.5,
                    color: light?.color ?? new Vector3(1, 1, 1),
                    intensity: light?.intensity ?? 1.0,
                });
            }
        }
        attachStarRayMarchingPostProcess(scene, camera, stars);

        // Teleport
        window.addEventListener("keydown", (e) => {
            if (e.key.toLowerCase() === "t") {
                const sol = loadedSystems.get("AlphaCentauri");
                const pluto = sol?.bodies.get("Proxima_b");
                if (!pluto) return;

                teleportToEntity(camera, pluto.positionWorldDouble, pluto.diameter, 20);
                lod.resetNow();
                shadowSystem.forcePickNow();
            }
        });

        new PostProcess("Pipeline", scene, camera);

        // HUD vitesse + distance (inchangé)
        let emaMS = 0;
        let lastHudUpdate = performance.now();
        const TAU = 0.1;
        const HUD_RATE_MS = 250;
        let lastDistLog = performance.now();
        const DIST_LOG_RATE_MS = 500;

        scene.onBeforeRenderObservable.add(() => {
            const now = performance.now();
            const dt = scene.getEngine().getDeltaTime() / 1000;

            if (now - lastDistLog >= DIST_LOG_RATE_MS) {
                const dSim = camera.distanceToSim(body.positionWorldDouble);
                const dKm = ScaleManager.toRealUnits(dSim);
                console.log(`${body.name}: ${dKm.toFixed(0)} km`);
                lastDistLog = now;
            }

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
