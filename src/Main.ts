import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";
import { Engine } from "@babylonjs/core";
import { FloatingCameraScene } from "./App";
import { EngineSetup } from "./core/EngineSetup";

window.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const useWebGPU = false;

    // Create and initialize the engine using EngineSetup
    const engineSetup = await EngineSetup.Create(canvas, useWebGPU);
    const engine: Engine = engineSetup.engine as Engine;

    // Create the scene using the engine and canvas
    const scene = FloatingCameraScene.CreateScene(engine, canvas);

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
