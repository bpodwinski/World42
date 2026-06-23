import {
    Engine,
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
import planetsJson from '../game_world/stellar_system/data.json';
import {
    listStellarSystems,
    loadStellarSystemFromCatalog,
    type LoadedBody,
    type LoadedSystem,
} from '../game_world/stellar_system/stellar_catalog_loader';

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
    engine: Engine | WebGPUEngine,
    canvas: HTMLCanvasElement,
    disposables: DisposableRegistry
): Promise<SceneBootstrapResult> {
    const scene = new Scene(engine);
    scene.clearColor.set(0, 0, 0, 1);
    scene.collisionsEnabled = true;
    scene.onDisposeObservable.add(() => disposables.dispose());

    const systemIds = listStellarSystems(planetsJson);
    const loadedSystemsArr = await Promise.all(
        systemIds.map((id) => loadStellarSystemFromCatalog(scene, planetsJson, id))
    );
    const loadedSystems = new Map(loadedSystemsArr.map((system) => [system.systemId, system]));
    const spawnBody = pickSpawnBody(loadedSystems);

    scene.textures.forEach((texture) => {
        texture.anisotropicFilteringLevel = 16;
    });

    const gui = new GuiManager(scene);
    gui.setMouseCrosshairVisible(true);
    disposables.add(() => gui.dispose());

    // Spawn on the star-facing side, backed off, so the lit hemisphere faces the
    // camera and the whole planet is framed. Offsetting toward the star (plus a
    // little "up") also keeps the look-at-centre direction away from the up vector,
    // avoiding the setTarget gimbal singularity (straight-down look) that silently
    // left the camera pointing at the horizon (planet at the bottom/top of screen).
    const spawnSystem = loadedSystems.get('Sol') ?? Array.from(loadedSystems.values())[0];
    const spawnStar = spawnSystem
        ? Array.from(spawnSystem.bodies.values()).find((b) => b.bodyType === 'star')
        : undefined;
    const spawnR = spawnBody.radiusSim;
    const toStar = spawnStar
        ? spawnStar.positionWorldDouble.subtract(spawnBody.positionWorldDouble).normalize()
        : new Vector3(-1, 0, 0);
    // Offset AWAY from the star: the terrain shader lights the hemisphere facing
    // (planet - star), so the anti-star side is the lit one to spawn looking at.
    const spawnPosWorldDouble = spawnBody.positionWorldDouble.clone();
    spawnPosWorldDouble.addInPlace(toStar.scale(-spawnR * 1.7));
    spawnPosWorldDouble.y += spawnR * 0.5;

    const camera = new OriginCamera('camera_player', spawnPosWorldDouble, scene);
    camera.debugMode = true;
    camera.minZ = 0.1;
    camera.maxZ = 1e9;
    camera.fov = 1.4;
    camera.applyGravity = false;
    camera.inertia = 0;
    camera.inputs.clear();
    camera.checkCollisions = false;

    // Spawn orientation: already level relative to the planet (zero roll) and
    // looking down at the surface ahead in oblique (not straight at the centre,
    // which would start on the radial pole = gimbal). Built directly as a basis so
    // the horizon-stabilized controller starts in a clean state.
    const radialUp = spawnPosWorldDouble.subtract(spawnBody.positionWorldDouble);
    radialUp.normalize();
    // Stable horizontal tangent from a world reference (not toStar, which is ~radial
    // here). Steep elevation keeps the planet roughly centred while staying off the
    // radial pole (where the camera basis / yaw would be singular).
    const ref = Math.abs(radialUp.y) < 0.95 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const east = Vector3.Cross(ref, radialUp);
    east.normalize();
    const north = Vector3.Cross(radialUp, east);
    north.normalize();
    const spawnElev = -1.48; // ~5° off nadir: planet centred + filling the view, basis still defined
    const spawnFwd = north.scale(Math.cos(spawnElev)).add(radialUp.scale(Math.sin(spawnElev)));
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
