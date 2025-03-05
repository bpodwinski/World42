import { Engine, WebGPUEngine } from "@babylonjs/core";

/**
 * EngineSetup centralizes the initialization and global configuration of the Babylon.js engine
 */
export class EngineSetup {
    public engine: Engine | WebGPUEngine;

    private constructor(engine: Engine | WebGPUEngine) {
        this.engine = engine;
    }

    /**
     * Creates a new EngineSetup instance by initializing the engine
     *
     * @param canvas - HTMLCanvasElement used for rendering
     * @param useWebGPU - Whether to use WebGPU (default false)
     * @returns Promise resolving to an EngineSetup instance with the engine initialized
     */
    public static async Create(
        canvas: HTMLCanvasElement,
        useWebGPU: boolean = false
    ): Promise<EngineSetup> {
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
        return new EngineSetup(engine);
    }
}
