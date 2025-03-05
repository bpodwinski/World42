import { Engine, WebGPUEngine } from "@babylonjs/core";

/**
 * EngineManager centralizes the initialization and global configuration of the Babylon.js engine
 */
export class EngineManager {
    public engine: Engine | WebGPUEngine;

    private constructor(engine: Engine | WebGPUEngine) {
        this.engine = engine;
    }

    /**
     * Creates a new EngineManager instance by initializing the engine
     *
     * @param canvas - HTMLCanvasElement used for rendering
     * @param useWebGPU - Whether to use WebGPU (default false)
     * @returns Promise resolving to an EngineManager instance with the engine initialized
     */
    public static async Create(
        canvas: HTMLCanvasElement,
        useWebGPU: boolean = false
    ): Promise<EngineManager> {
        let engine: Engine | WebGPUEngine;
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
            });
        }
        return new EngineManager(engine);
    }
}
