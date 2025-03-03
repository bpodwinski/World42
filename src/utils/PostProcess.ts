import { DefaultRenderingPipeline, Scene } from "@babylonjs/core";
import { OriginCamera } from "./OriginCamera";

/**
 * PostProcess class for managing the post-processing pipeline.
 * This class configures Babylon.js's default rendering pipeline to apply various effects
 * (tone mapping, FXAA, bloom, sharpen, etc.) on the scene.
 */
export class PostProcess {
    /** The default rendering pipeline instance. */
    public pipeline: DefaultRenderingPipeline;

    /**
     * Creates a new post-processing pipeline.
     *
     * @param name - The name of the pipeline.
     * @param scene - The Babylon.js scene on which to apply the pipeline.
     * @param camera - The camera to use within the pipeline.
     */
    constructor(name: string, scene: Scene, camera: OriginCamera) {
        this.pipeline = new DefaultRenderingPipeline(name, true, scene, [
            camera,
        ]);

        // Image processing configuration.
        this.pipeline.imageProcessingEnabled = true;
        this.pipeline.imageProcessing.toneMappingEnabled = true;
        this.pipeline.imageProcessing.toneMappingType = 1;
        this.pipeline.imageProcessing.exposure = 1.2;
        this.pipeline.imageProcessing.contrast = 1.0;

        // Enable FXAA (anti-aliasing).
        this.pipeline.fxaaEnabled = true;

        // Enable and configure bloom effect.
        this.pipeline.bloomEnabled = true;
        this.pipeline.bloomThreshold = 0;
        this.pipeline.bloomKernel = 90;
        this.pipeline.bloomWeight = 0.4;

        // Enable and configure sharpening effect.
        this.pipeline.sharpenEnabled = true;
        this.pipeline.sharpen.edgeAmount = 0.1;
        this.pipeline.sharpen.colorAmount = 1.0;

        // Number of samples used for anti-aliasing.
        this.pipeline.samples = 4;
    }
}
