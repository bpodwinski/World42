import {
    Matrix,
    MeshBuilder,
    Quaternion,
    Scene,
    UniversalCamera,
    Vector3,
    Viewport,
    WebGPUEngine,
} from '@babylonjs/core';
import { OriginCamera } from '../core/camera/camera_manager';
import { MouseSteerControlManager } from '../core/control/mouse_steer_control_manager';
import { GuiManager } from '../core/gui/gui_manager';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import { ScaleManager } from '../core/scale/scale_manager';
import { DEFAULT_NOISE, fbmNoise } from '../systems/lod/cbt/cbt_noise';
import planetsJson from '../game_world/stellar_system/data.json';
import {
    listStellarSystems,
    loadStellarSystemFromCatalog,
    type LoadedBody,
    type LoadedSystem,
} from '../game_world/stellar_system/stellar_catalog_loader';
import {
    applyBenchOverride,
    benchSystemIds,
    parseBenchAlgorithm,
} from '../game_world/stellar_system/bench_override';

export type SceneBootstrapResult = {
    scene: Scene;
    camera: OriginCamera;
    gui: GuiManager;
    control: MouseSteerControlManager;
    spawnBody: LoadedBody;
    loadedSystems: Map<string, LoadedSystem>;
};

function pickSpawnBody(loadedSystems: Map<string, LoadedSystem>): LoadedBody {
    const loadedSystemsArr = Array.from(loadedSystems.values());
    const activeSystem = loadedSystems.get('Sol') ?? loadedSystemsArr[0];
    const body =
        activeSystem.bodies.get('Mercury') ??
        Array.from(activeSystem.bodies.values()).find((candidate) => candidate.bodyType !== 'star');

    if (!body) {
        throw new Error('Aucun corps (planete) trouve dans le systeme actif.');
    }

    return body;
}

export async function bootstrapScene(
    engine: WebGPUEngine,
    canvas: HTMLCanvasElement,
    disposables: DisposableRegistry
): Promise<SceneBootstrapResult> {
    const scene = new Scene(engine);
    scene.clearColor.set(0, 0, 0, 1);
    scene.collisionsEnabled = true;
    scene.onDisposeObservable.add(() => disposables.dispose());

    // Dev perf benchmark: `?bench=<algo>` loads ONLY the dedicated Benchmark
    // system and forces its planet onto <algo>, so the same world can be timed
    // under each LOD backend in isolation (see bench_override.ts).
    const benchAlgo = parseBenchAlgorithm(
        typeof window !== 'undefined' ? window.location.search : ''
    );
    const systemIds = benchSystemIds(listStellarSystems(planetsJson), benchAlgo);
    const loadedSystemsArr = await Promise.all(
        systemIds.map((id) => loadStellarSystemFromCatalog(scene, planetsJson, id))
    );
    const loadedSystems = new Map(loadedSystemsArr.map((system) => [system.systemId, system]));
    applyBenchOverride(loadedSystems, benchAlgo);
    const spawnBody = pickSpawnBody(loadedSystems);

    scene.textures.forEach((texture) => {
        texture.anisotropicFilteringLevel = 16;
    });

    const gui = new GuiManager(scene);
    gui.setMouseCrosshairVisible(true);
    disposables.add(() => gui.dispose());

    // Spawn just above the surface at the planet's NORTH POLE (planet-local +Y =
    // the octahedron's +Y vertex; the pivot only spins about Y, so local +Y maps to
    // world +Y), looking out toward the lit limb tilted slightly below the horizon
    // so foreground terrain and the horizon are both framed.
    const spawnSystem = loadedSystems.get('Sol') ?? Array.from(loadedSystems.values())[0];
    const spawnStar = spawnSystem
        ? Array.from(spawnSystem.bodies.values()).find((b) => b.bodyType === 'star')
        : undefined;
    const spawnR = spawnBody.radiusSim;
    const toStar = spawnStar
        ? spawnStar.positionWorldDouble.subtract(spawnBody.positionWorldDouble).normalize()
        : new Vector3(-1, 0, 0);

    // Radial up at the north pole, and the real ground radius there: mean radius +
    // fbm height sampled at the pole direction (same field the terrain shader uses).
    // DEFAULT_NOISE matches the planet's noise except for octaves (quality preset);
    // the clearance dwarfs that sub-metre difference, so the camera sits a fixed low
    // altitude above the actual surface whatever the local relief.
    //
    // Clearance is ~7 km: the GPU CBT is depth-capped (GPU_MAX_DEPTH=18 → ~24 km
    // finest triangles, see references/13_gpu_cbt_webgpu.md), so very close to the
    // surface the coarse facets straddle the camera and the mesh breaks up (cracks
    // show the skybox). Empirically the floor is ~4 km above the pole surface; 7 km
    // gives a clean, watertight near-surface view with margin. To hug the ground
    // tighter, the depth cap must be raised (decouple draw count from D).
    const radialUp = new Vector3(0, 1, 0);
    const poleTerrainSim = fbmNoise(radialUp.x, radialUp.y, radialUp.z, DEFAULT_NOISE);
    const clearanceSim = ScaleManager.toSimulationUnits(7); // ~7 km above the ground
    const camAltitudeSim = spawnR + poleTerrainSim + clearanceSim;
    const spawnPosWorldDouble = spawnBody.positionWorldDouble.add(radialUp.scale(camAltitudeSim));

    const camera = new OriginCamera('camera_player', spawnPosWorldDouble, scene);
    camera.debugMode = true;
    camera.minZ = 0.1;
    camera.maxZ = 1e9;
    camera.fov = 1.4;
    camera.applyGravity = false;
    camera.inertia = 0;
    camera.inputs.clear();
    camera.checkCollisions = false;

    // Orientation: look toward the lit limb (toStar projected onto the local tangent
    // plane), tilted ~14° below the horizon, with zero roll relative to the planet.
    // At the pole toStar is already tangent to the surface, so the forward tangent is
    // well-defined (no gimbal). Built as an explicit basis so the steering controller
    // starts in a clean, level state.
    let tangentFwd = toStar.subtract(radialUp.scale(Vector3.Dot(toStar, radialUp)));
    if (tangentFwd.lengthSquared() < 1e-6) {
        // Degenerate (pole faces the star): fall back to a world-X tangent.
        tangentFwd = new Vector3(1, 0, 0).subtract(radialUp.scale(radialUp.x));
    }
    tangentFwd.normalize();
    const spawnElev = -0.25; // ~14° below the horizon: foreground terrain + horizon
    const spawnFwd = tangentFwd.scale(Math.cos(spawnElev)).add(radialUp.scale(Math.sin(spawnElev)));
    spawnFwd.normalize();
    const spawnRight = Vector3.Cross(radialUp, spawnFwd);
    spawnRight.normalize();
    const spawnUp = Vector3.Cross(spawnFwd, spawnRight);
    spawnUp.normalize();
    const spawnBasis = Matrix.Identity();
    Matrix.FromXYZAxesToRef(spawnRight, spawnUp, spawnFwd, spawnBasis);
    camera.rotationQuaternion = Quaternion.FromRotationMatrix(spawnBasis);

    const camCollider = MeshBuilder.CreateSphere('camCollider', { segments: 64, diameter: 0.05 }, scene);
    camCollider.isVisible = false;
    camCollider.isPickable = false;
    camCollider.checkCollisions = true;
    camCollider.position.set(0, 0, 0);
    camCollider.ellipsoid = new Vector3(0.05, 0.05, 0.05);
    camCollider.ellipsoidOffset = new Vector3(0.05, 0.05, 0.05);

    const afterMeshesObserver = scene.onAfterActiveMeshesEvaluationObservable.add(() => {
        camCollider.position.set(0, 0, 0);
    });
    disposables.addBabylonObserver(scene.onAfterActiveMeshesEvaluationObservable, afterMeshesObserver);

    const control = new MouseSteerControlManager(camera, scene, canvas, camCollider, {});
    control.gui = gui;
    disposables.add(() => control.dispose());

    // Debug overview camera: top-right inset + IJKL/UO fly. Off by default; flip to
    // re-enable the inset.
    const ENABLE_DEBUG_CAM = false;
    camera.viewport = new Viewport(0, 0, 1, 1);

    if (ENABLE_DEBUG_CAM) {
        const debugCam = new UniversalCamera('debugCam', Vector3.Zero(), scene);
        debugCam.minZ = camera.minZ;
        debugCam.maxZ = camera.maxZ;
        debugCam.fov = camera.fov;
        debugCam.inputs.clear();

        const debugDoublePos = camera.doublepos
            .clone()
            .add(new Vector3(0, 0, spawnBody.radiusSim * 3.0));
        const debugDoubleTgt = spawnBody.positionWorldDouble.clone();

        debugCam.viewport = new Viewport(0.5, 0.5, 0.5, 0.5);
        scene.activeCameras = [camera, debugCam];

        const tmpTgtRender = new Vector3();
        const debugCamObserver = scene.onBeforeRenderObservable.add(() => {
            camera.toRenderSpace(debugDoublePos, debugCam.position);
            camera.toRenderSpace(debugDoubleTgt, tmpTgtRender);
            debugCam.setTarget(tmpTgtRender);
        });
        disposables.addBabylonObserver(scene.onBeforeRenderObservable, debugCamObserver);

        const keys = new Set<string>();
        disposables.addDomListener(window, 'keydown', (e) => keys.add(e.key.toLowerCase()));
        disposables.addDomListener(window, 'keyup', (e) => keys.delete(e.key.toLowerCase()));

        const debugMoveObserver = scene.onBeforeRenderObservable.add(() => {
            const dt = engine.getDeltaTime() / 1000;
            const speed = spawnBody.radiusSim * 0.4 * dt;

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
        disposables.addBabylonObserver(scene.onBeforeRenderObservable, debugMoveObserver);
    } else {
        scene.activeCamera = camera;
    }

    return { scene, camera, gui, control, spawnBody, loadedSystems };
}
