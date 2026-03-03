import type { Engine, Scene, WebGPUEngine } from '@babylonjs/core';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import { bootstrapScene } from './bootstrap_scene';
import { setupLodAndShadows } from './setup_lod_and_shadows';
import { setupRuntime } from './setup_runtime';

/**
 * Coordinate space conventions used throughout:
 *
 * - WorldDouble (sim units): high precision absolute positions in `doublepos`.
 * - Render-space (sim units): floating-origin relative space for rendering.
 * - Planet-local (sim units): mesh/shader space centered on each planet.
 */
export async function createFloatingCameraScene(
    engine: Engine | WebGPUEngine,
    canvas: HTMLCanvasElement
): Promise<Scene> {
    const disposables = new DisposableRegistry();
    const { scene, camera, gui, spawnBody, loadedSystems } = await bootstrapScene(
        engine,
        canvas,
        disposables
    );

    const { lod, refreshActivePlanetSelection } = setupLodAndShadows(
        scene,
        engine,
        camera,
        loadedSystems,
        disposables
    );

    setupRuntime({
        scene,
        engine,
        camera,
        gui,
        spawnBody,
        loadedSystems,
        lod,
        refreshActivePlanetSelection,
        disposables,
    });

    return scene;
}
