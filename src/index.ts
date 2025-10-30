import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";
import { FloatingCameraScene } from "./app";
import { EngineManager } from "./core/render/engine_manager";

window.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    // Create engine
    const engine = await EngineManager.CreateAuto(canvas);

    // Create scene (await, sinon c'est une Promise<Scene>)
    const scene = await FloatingCameraScene.CreateScene(engine, canvas);

    // Toggle the debug layer when the "²" key is pressed
    window.addEventListener("keydown", (evt) => {
        if (evt.key === "p") {
            if (scene.debugLayer.isVisible()) {
                scene.debugLayer.hide();
            } else {
                scene.debugLayer.show({ overlay: true });
            }
        }
    });

    // Resize
    window.addEventListener("resize", () => {
        engine.resize();
    });
});
