import { FloatingCameraScene } from "./app";
import { EngineManager } from "./core/render/engine_manager";
import { DisposableRegistry } from "./core/lifecycle/disposable_registry";

let debugLayerReady: Promise<void> | null = null;

function ensureDebugLayerReady(): Promise<void> {
    // Dev-only: the BabylonJS Inspector (and its react-dom / addons peers) is never bundled
    // into the production (gh-pages) build. __DEV__ is replaced by `false` there, so this
    // dynamic import is dead-code-eliminated and the public bundle stays lean.
    if (!__DEV__) return Promise.resolve();
    if (!debugLayerReady) {
        debugLayerReady = Promise.all([
            import("@babylonjs/core/Debug/debugLayer"),
            import("@babylonjs/inspector"),
        ]).then(() => undefined);
    }
    return debugLayerReady;
}

window.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const disposables = new DisposableRegistry();

    // Create engine
    const engine = await EngineManager.Create(canvas);

    // Create scene (await, sinon c'est une Promise<Scene>)
    const scene = await FloatingCameraScene.CreateScene(engine, canvas);
    scene.onDisposeObservable.add(() => disposables.dispose());

    // Toggle the debug layer (dev only — the Inspector is not bundled in production).
    if (__DEV__) {
        disposables.addDomListener(window, "keydown", async (e) => {
            if (e.key === "m") {
                await ensureDebugLayerReady();
                if (scene.debugLayer.isVisible()) {
                    scene.debugLayer.hide();
                } else {
                    scene.debugLayer.show({ overlay: true });
                }
            }
        });
    }

    // Resize
    disposables.addDomListener(window, "resize", () => {
        engine.resize();
    });
});
