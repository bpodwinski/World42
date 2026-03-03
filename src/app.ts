import type { Engine, Scene, WebGPUEngine } from '@babylonjs/core';
import '@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader';
import { createFloatingCameraScene } from './app/create_floating_camera_scene';

export class FloatingCameraScene {
    public static async CreateScene(
        engine: Engine | WebGPUEngine,
        canvas: HTMLCanvasElement
    ): Promise<Scene> {
        return createFloatingCameraScene(engine, canvas);
    }
}
