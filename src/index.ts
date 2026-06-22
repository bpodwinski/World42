import { FloatingCameraScene } from "./app";
import { EngineManager } from "./core/render/engine_manager";
import { DisposableRegistry } from "./core/lifecycle/disposable_registry";
import { ChunkTree } from "./systems/lod/chunks/chunk_tree";
import { runGpuCbtSelfTest } from "./systems/lod/cbt/gpu/gpu_cbt_selftest";
import type { WebGPUEngine } from "@babylonjs/core";

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

    // GPU CBT Phase 1 self-test (opt-in via ?cbtgputest=1). Validates the WGSL
    // heap + sum-reduction against the CPU reference, then stops (no scene).
    if (new URLSearchParams(window.location.search).has("cbtgputest")) {
        await runGpuCbtSelfTest(engine as WebGPUEngine);
        return;
    }

    // Create scene (await, sinon c'est une Promise<Scene>)
    const scene = await FloatingCameraScene.CreateScene(engine, canvas);
    scene.onDisposeObservable.add(() => disposables.dispose());

    // Dev inspection hook (removed before finalization).
    (window as unknown as { __w42: unknown }).__w42 = { scene, engine };

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
            ChunkTree.debugLODEnabled = !ChunkTree.debugLODEnabled;
        }
    });

    // Resize
    disposables.addDomListener(window, "resize", () => {
        engine.resize();
    });
});
