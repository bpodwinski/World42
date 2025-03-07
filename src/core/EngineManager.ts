import { Engine, WebGPUEngine, WebGPUEngineOptions } from "@babylonjs/core";

/**
 * EngineManager centralizes the initialization and global configuration of the Babylon.js engine
 */
export class EngineManager {
    /**
     * Creates and returns a new WebGL2 Engine instance
     *
     * @param canvas - HTMLCanvasElement used for rendering
     * @returns A WebGL2 Engine instance
     */
    public static CreateWebGL2(canvas: HTMLCanvasElement): Engine {
        return new Engine(canvas, true, {
            preserveDrawingBuffer: true,
            stencil: true,
        });
    }

    /**
     * Creates and returns a new WebGPUEngine instance
     *
     * @param canvas - HTMLCanvasElement used for rendering
     * @returns Promise resolving to a WebGPUEngine instance
     */
    public static async CreateWebGPU(
        canvas: HTMLCanvasElement
    ): Promise<WebGPUEngine> {
        const engine = new WebGPUEngine(canvas, {
            stencil: true,
            antialias: true,
            deviceDescriptor: {
                requiredLimits: {
                    maxTextureDimension2D: 16384,
                    maxBufferSize: 2147483648,
                },
            },
        } as WebGPUEngineOptions);
        await engine.initAsync();

        return engine;
    }
}
