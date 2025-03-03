import { Engine } from "@babylonjs/core";
import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";

import { FloatingCameraScene } from "./App";

window.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        // @ts-ignore
        useLogarithmicDepthBuffer: true,
    });

    const scene = FloatingCameraScene.CreateScene(engine, canvas);
    scene.debugLayer.show();

    engine.runRenderLoop(() => {
        scene.render();
    });

    window.addEventListener("resize", () => {
        engine.resize();
    });
});
