import { FloatingCameraScene } from "./app";
import { EngineManager } from "./core/render/engine_manager";
import { DisposableRegistry } from "./core/lifecycle/disposable_registry";
import { LodConfig } from "./systems/lod/lod_config";

let debugLayerReady: Promise<void> | null = null;

function ensureDebugLayerReady(): Promise<void> {
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
    const engine = await EngineManager.CreateAuto(canvas);

    // Create scene (await, sinon c'est une Promise<Scene>)
    const scene = await FloatingCameraScene.CreateScene(engine, canvas);
    scene.onDisposeObservable.add(() => disposables.dispose());

    // Toggle the debug layer
    disposables.addDomListener(window, "keydown", async (e) => {
        if (e.key === "p") {
            await ensureDebugLayerReady();
            if (scene.debugLayer.isVisible()) {
                scene.debugLayer.hide();
            } else {
                scene.debugLayer.show({ overlay: true });
            }
        }

        if (e.key === "m") {
            LodConfig.debugLODEnabled = !LodConfig.debugLODEnabled;
        }

        if (e.key === "w") {
            LodConfig.wireframeOverlay = !LodConfig.wireframeOverlay;
            console.log(`[debug] wireframeOverlay = ${LodConfig.wireframeOverlay}`);
        }
    });

    // Resize
    disposables.addDomListener(window, "resize", () => {
        engine.resize();
    });
});
