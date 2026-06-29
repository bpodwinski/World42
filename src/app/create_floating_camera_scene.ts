import type { Scene, WebGPUEngine } from '@babylonjs/core';
import { DisposableRegistry } from '../core/lifecycle/disposable_registry';
import { TerrainOptionsMenu } from './terrain_options_menu';
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
    engine: WebGPUEngine,
    canvas: HTMLCanvasElement
): Promise<Scene> {
    const disposables = new DisposableRegistry();
    const { scene, camera, gui, spawnBody, loadedSystems } = await bootstrapScene(
        engine,
        canvas,
        disposables
    );

    const { lod, refreshActivePlanetSelection, stars, occluders, atmospheres } = setupLodAndShadows(
        scene,
        engine,
        camera,
        loadedSystems,
        disposables
    );

    const { fsr1RenderScale, setFsr1RenderScale } = setupRuntime({
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
    });

    // In-game terrain options menu (press O). Auto-generated from the param schema; edits persist to
    // localStorage per profile. "Apply" HOT-REBUILDS the affected planets in place (no reload) via
    // lod.rebuildProfile. Defaults to the dev Moon's profile (selena).
    const terrainMenu = new TerrainOptionsMenu({
        initialProfileId: 'selena',
        onApply: (profileId) => lod.rebuildProfile(profileId),
        renderSettings: {
            fsr1RenderScale,
            onFsr1RenderScaleChange: setFsr1RenderScale
        }
    });
    disposables.add(() => terrainMenu.dispose());

    return scene;
}
