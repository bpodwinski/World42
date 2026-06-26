import { WebGPUEngine, WebGPUEngineOptions } from "@babylonjs/core";

export class EngineManager {
    /**
     * Creates and returns a new WebGPUEngine instance.
     * Throws if WebGPU is not available in the current browser.
     *
     * @param canvas - HTMLCanvasElement used for rendering
     * @returns Promise resolving to a WebGPUEngine instance
     */
    public static async Create(
        canvas: HTMLCanvasElement
    ): Promise<WebGPUEngine> {
        if (typeof navigator === "undefined" || !("gpu" in navigator)) {
            throw new Error(
                "[EngineManager] WebGPU is not available in this browser. " +
                "World42 requires a WebGPU-capable browser (Chrome 113+, Edge 113+)."
            );
        }

        const engine = new WebGPUEngine(canvas, {
            stencil: true,
            antialias: true,
            // Request timestamp-query for real GPU timing in the perf HUD.
            // enableGPUTimingMeasurements is a PROPERTY (armed below), not a constructor option.
            deviceDescriptor: { requiredFeatures: ['timestamp-query'] as GPUFeatureName[] },
        } as WebGPUEngineOptions);

        await engine.initAsync();
        engine.enableGPUTimingMeasurements = true;
        console.info("[EngineManager] active=webgpu");

        return engine;
    }
}
