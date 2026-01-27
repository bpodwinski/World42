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

    window.addEventListener("keydown", (e) => {
        // Toggle the debug layer
        if (e.key === "p") {
            if (scene.debugLayer.isVisible()) {
                scene.debugLayer.hide();
            } else {
                scene.debugLayer.show({ overlay: true });
            }
        }

        if (e.key === "l" || e.key === "L") {
            ChunkTree.debugLODEnabled = !ChunkTree.debugLODEnabled;
        }

        if (e.key === 'b' || e.key === 'B') {
            ChunkTree.showBoundingSpheres = !ChunkTree.showBoundingSpheres;
        }
    });

    // Resize
    window.addEventListener("resize", () => {
        engine.resize();
    });
});
