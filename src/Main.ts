import { Engine, WebGPUEngine } from "@babylonjs/core";
import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";

import { FloatingCameraScene } from "./App";

window.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const useWebGPU = false;
    let engine;

    if (useWebGPU) {
        engine = new WebGPUEngine(canvas, {
            stencil: true,
            antialias: true,
            enableAllFeatures: true,
        });
        await engine.initAsync();
    } else {
        engine = new Engine(canvas, true, {
            preserveDrawingBuffer: true,
            stencil: true,
            // @ts-ignore
            useLogarithmicDepthBuffer: true,
        });
    }

    const scene = FloatingCameraScene.CreateScene(engine as Engine, canvas);
    //scene.debugLayer.show();

    engine.runRenderLoop(() => {
        scene.render();
    });

    window.addEventListener("resize", () => {
        engine.resize();
    });
});
