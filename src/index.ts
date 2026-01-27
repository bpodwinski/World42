import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";
import { FloatingCameraScene } from "./app";
import { EngineManager } from "./core/render/engine_manager";
import { ChunkTree } from "./systems/lod/chunks/chunk_tree";

window.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    // Create engine
    const engine = await EngineManager.CreateAuto(canvas);

    // Create scene (await, sinon c'est une Promise<Scene>)
    const scene = await FloatingCameraScene.CreateScene(engine, canvas);

    // Toggle the debug layer
    window.addEventListener("keydown", (e) => {
        if (e.key === "p") {
            if (scene.debugLayer.isVisible()) {
                scene.debugLayer.hide();
            } else {
                scene.debugLayer.show({ overlay: true });
            }
        }

        if (e.key === "m") {
            ChunkTree.debugLODEnabled = !ChunkTree.debugLODEnabled;
        }
    });

    // Resize
    window.addEventListener("resize", () => {
        engine.resize();
    });
});
