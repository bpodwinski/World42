import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";
import { FloatingCameraScene } from "./App";
import { EngineManager } from "./engine/core/EngineManager";

window.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    // Create engine
    const engine = await EngineManager.CreateAuto(canvas);

    // Create scene
    const scene = FloatingCameraScene.CreateScene(engine, canvas);

    // Global flag for debugLOD
    let debugLODEnabled = false;

    // Toggle the debug layer when the "²" key is pressed
    window.addEventListener("keydown", (evt) => {
        if (evt.key === "²") {
            if (scene.debugLayer.isVisible()) {
                scene.debugLayer.hide();
            } else {
                scene.debugLayer.show();
            }
        }
    });

    // Run the render loop
    engine.runRenderLoop(() => {
        scene.render();
    });

    // Resize the engine on window resize
    window.addEventListener("resize", () => {
        engine.resize();
    });
});
