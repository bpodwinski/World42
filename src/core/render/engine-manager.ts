import { Engine as WebGL2Engine, WebGPUEngine, WebGPUEngineOptions } from "@babylonjs/core";

/**
 * Centralizes creation and configuration of the Babylon.js rendering engine. Selects between WebGPU and WebGL2 based on environment and runtime support
 */
export class EngineManager {
    /**
     * Creates and returns a new WebGL2 Engine instance
     *
     * @param canvas - HTMLCanvasElement used for rendering
     * @returns A WebGL2 Engine instance
     */
    public static CreateWebGL2(canvas: HTMLCanvasElement): WebGL2Engine {
        const engine = new WebGL2Engine(canvas, true, {
            preserveDrawingBuffer: true,
            stencil: true,
        });

        console.info(`[EngineManager] active=webgl2 | mode=forced-webgl2`);

        return engine;
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
        } as WebGPUEngineOptions);

        await engine.initAsync();
        console.info(`[EngineManager] active=webgpu | mode=forced-webgpu`);

        return engine;
    }

    /**
     * Create an engine according to the `process.env.ENGINE` setting:
     * - `"webgpu"`: Try WebGPU, fallback to WebGL2 if unavailable or init fails
     * - `"webgl2"`: Force WebGL2
     * - `"auto"`: (default)
     *
     * @param canvas - The HTML canvas used for rendering
     * @returns A promise that resolves to a `WebGPUEngine` or a WebGL2 `Engine`
     */
    public static async CreateAuto(
        canvas: HTMLCanvasElement
    ): Promise<WebGL2Engine | WebGPUEngine> {
        const mode = (process.env.ENGINE || "auto").toLowerCase();

        // Quick runtime capability check to avoid throwing on unsupported browsers
        const hasWebGPU = typeof (navigator as any).gpu !== "undefined";

        if (mode === "webgl2") {
            const engine = new WebGL2Engine(canvas, true, {
                preserveDrawingBuffer: true,
                stencil: true,
            });

            console.info(`[EngineManager] active=webgl2 | mode=${mode}`);

            return engine;
        }

        if (mode === "webgpu") {
            if (!hasWebGPU) {
                console.warn(
                    "[EngineManager] WebGPU requested but not available. Falling back to WebGL2"
                );

                const engine = new WebGL2Engine(canvas, true, {
                    preserveDrawingBuffer: true,
                    stencil: true,
                });

                console.info(`[EngineManager] active=webgl2 | mode=${mode}`);

                return engine;
            }

            try {
                const engine = new WebGPUEngine(canvas, {
                    stencil: true,
                    antialias: true,
                } as WebGPUEngineOptions);

                await engine.initAsync();
                console.info(`[EngineManager] active=webgpu | mode=${mode}`);

                return engine;

            } catch (error) {
                console.warn(
                    `[EngineManager] WebGPU init failed → fallback to WebGL2 | mode=${mode}`,
                    error
                );

                const engine = new WebGL2Engine(canvas, true, {
                    preserveDrawingBuffer: true,
                    stencil: true,
                });

                console.info(`[EngineManager] active=webgl2 | mode=${mode}`);

                return engine;
            }
        }

        // "auto"
        if (hasWebGPU) {
            try {
                const engine = new WebGPUEngine(canvas, {
                    stencil: true,
                    antialias: true,
                } as WebGPUEngineOptions);

                await engine.initAsync();
                console.info(`[EngineManager] active=webgpu | mode=${mode}`);

                return engine;

            } catch (error) {
                console.warn(
                    `[EngineManager] WebGPU init failed in auto → fallback to WebGL2 | mode=${mode}`,
                    error
                );
            }
        }

        return this.CreateWebGL2(canvas);
    }
}
