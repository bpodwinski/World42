import type { Engine, WebGPUEngine, Scene } from "@babylonjs/core";
import { Color4, Scene as BabylonScene } from "@babylonjs/core";

export function createBaseScene(engine: Engine | WebGPUEngine): Scene {
    const scene = new BabylonScene(engine);

    // Defaults “engine-level”
    scene.clearColor = new Color4(0, 0, 0, 1);
    scene.collisionsEnabled = true;

    return scene;
}
