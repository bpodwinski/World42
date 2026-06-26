import {
    Color4,
    Constants,
    FrameGraph,
    FrameGraphBloomTask,
    FrameGraphClearTextureTask,
    FrameGraphCopyToBackbufferColorTask,
    FrameGraphFXAATask,
    FrameGraphImageProcessingTask,
    FrameGraphObjectList,
    FrameGraphObjectRendererTask,
    FrameGraphPostProcessTask,
    FrameGraphSharpenTask,
    FrameGraphTAATask,
    ImageProcessingConfiguration,
    ShaderLanguage,
    type Effect,
    type FrameGraphRenderPass,
    type FrameGraphTextureHandle,
    type Scene,
} from '@babylonjs/core';
import { ThinCustomPostProcess } from '@babylonjs/core/PostProcesses/thinCustomPostProcess';
import { FrameGraphGUITask } from '@babylonjs/gui';
import type { AdvancedDynamicTexture } from '@babylonjs/gui';
import type { OriginCamera } from '../camera/camera_manager';
import {
    setStarUniforms,
    STAR_PP_FRAGMENT,
    STAR_PP_SAMPLERS,
    STAR_PP_UNIFORMS,
    type StarGlowSource,
    type StarOccluder,
} from './star_raymarch_postprocess';

/**
 * Frame Graph custom task for the star ray-march pass.
 *
 * Reads the scene color (auto-bound `textureSampler` = sourceTexture) plus the scene DEPTH
 * (bound via `bindTextureHandle` in the additionalBindings callback — the canonical pattern used
 * by Babylon's own depth-reading tasks, e.g. circleOfConfusionTask). All scalar/vector/matrix
 * uniforms are set per-frame in `onBindObservable` via the shared {@link setStarUniforms} helper.
 */
class FrameGraphStarTask extends FrameGraphPostProcessTask {
    /** Scene depth texture handle (terrain occlusion of the star). */
    public depthTexture?: FrameGraphTextureHandle;
    public depthSamplingMode = Constants.TEXTURE_NEAREST_SAMPLINGMODE;

    constructor(
        name: string,
        frameGraph: FrameGraph,
        scene: Scene,
        camera: OriginCamera,
        stars: StarGlowSource[],
        occluders: StarOccluder[] | undefined
    ) {
        const engine = frameGraph.engine;
        const pp = new ThinCustomPostProcess(name, engine, {
            name,
            engine,
            fragmentShader: STAR_PP_FRAGMENT,
            useShaderStore: false,
            uniformNames: [...STAR_PP_UNIFORMS],
            samplerNames: [...STAR_PP_SAMPLERS],
            shaderLanguage: ShaderLanguage.GLSL,
        });
        super(name, frameGraph, pp);
        pp.onBindObservable.add((effect: Effect) => {
            setStarUniforms(effect, scene, camera, stars, occluders);
        });
    }

    public override record(skipCreationOfDisabledPasses = false): FrameGraphRenderPass {
        if (this.sourceTexture === undefined || this.depthTexture === undefined) {
            throw new Error(`FrameGraphStarTask "${this.name}": sourceTexture and depthTexture are required`);
        }
        const pass = super.record(
            skipCreationOfDisabledPasses,
            (context) => {
                context.setTextureSamplingMode(this.depthTexture!, this.depthSamplingMode);
            },
            (context) => {
                const effect = this._postProcessDrawWrapper.effect;
                if (effect) {
                    context.bindTextureHandle(effect, 'depthSampler', this.depthTexture!);
                }
            }
        );
        pass.addDependencies(this.depthTexture);
        return pass;
    }
}

export type FrameGraphHandle = {
    frameGraph: FrameGraph;
    dispose: () => void;
};

export type FrameGraphOptions = {
    stars: StarGlowSource[];
    occluders?: StarOccluder[];
    /** Fullscreen GUI texture (must be created with useStandalone: true) for the HUD overlay. */
    gui: AdvancedDynamicTexture;
};

/**
 * Builds the World42 render pipeline as a Babylon Frame Graph and installs it on the scene.
 *
 * Replaces the imperative camera post-process stack (DefaultRenderingPipeline + TAA pipeline +
 * star post-process). The graph governs ONLY the render passes; the OCBT compute, floating-origin
 * integration and LOD tick keep running in their scene observables (see {@link setupRuntime}).
 *
 * Pass order (HDR until tonemap): Clear → ObjectRenderer (terrain+skybox) → Star (HDR) → TAA →
 * Bloom (HDR) → ImageProcessing (ACES tonemap + exposure) → FXAA → Sharpen → copy to backbuffer.
 *
 * NOTE: under a frame graph, `scene.render()` does NOT fire `onBeforeActiveMeshesEvaluationObservable`
 * (only `onBeforeRenderObservable`). The caller must re-fire it each frame so the floating-origin
 * camera integration still runs — see the fold-notify observer in {@link setupRuntime}.
 */
export function attachFrameGraph(
    scene: Scene,
    camera: OriginCamera,
    options: FrameGraphOptions
): FrameGraphHandle {
    const fg = new FrameGraph(scene, false);
    const tm = fg.textureManager;

    // Full-screen HDR color + depth render targets (1:1 with the canvas).
    const sceneColor = tm.createRenderTargetTexture('sceneColor', {
        size: 100,
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            samples: 1,
            types: [Constants.TEXTURETYPE_HALF_FLOAT],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            labels: ['sceneColor'],
        },
    });
    const sceneDepth = tm.createRenderTargetTexture('sceneDepth', {
        size: 100,
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            samples: 1,
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            types: [Constants.TEXTURETYPE_FLOAT],
            labels: ['sceneDepth'],
        },
    });

    // 1. Clear color + depth.
    const clear = new FrameGraphClearTextureTask('clear', fg);
    clear.color = new Color4(0, 0, 0, 1);
    clear.clearColor = true;
    clear.clearDepth = true;
    clear.clearStencil = false;
    clear.targetTexture = sceneColor;
    clear.depthTexture = sceneDepth;
    fg.addTask(clear);

    // 2. Render the scene meshes (OCBT terrain + skybox) into HDR color + depth.
    const objRenderer = new FrameGraphObjectRendererTask('sceneRender', fg, scene, {});
    objRenderer.camera = camera;
    objRenderer.targetTexture = clear.outputTexture;
    objRenderer.depthTexture = clear.outputDepthTexture;
    objRenderer.isMainObjectRenderer = true;
    objRenderer.disableImageProcessing = true; // tonemap is a dedicated task AFTER bloom
    const objectList = new FrameGraphObjectList();
    objectList.meshes = scene.meshes;
    objectList.particleSystems = scene.particleSystems;
    objRenderer.objectList = objectList;
    fg.addTask(objRenderer);

    // 3. Star ray-march (HDR, reads scene depth for terrain occlusion).
    const star = new FrameGraphStarTask('star', fg, scene, camera, options.stars, options.occluders);
    star.sourceTexture = objRenderer.outputTexture;
    star.depthTexture = objRenderer.outputDepthTexture;
    fg.addTask(star);

    // 4. TAA (accumulate while still; disabled on camera move; no reprojection — matches taa_postprocess.ts).
    const taa = new FrameGraphTAATask('taa', fg);
    taa.sourceTexture = star.outputTexture;
    taa.objectRendererTask = objRenderer;
    taa.postProcess.samples = 16;
    taa.postProcess.disableOnCameraMove = true;
    taa.postProcess.reprojectHistory = false;
    taa.postProcess.clampHistory = true;
    fg.addTask(taa);

    // 5. Bloom (HDR).
    const bloom = new FrameGraphBloomTask('bloom', fg, 0.25, 32, 0, true);
    bloom.sourceTexture = taa.outputTexture;
    fg.addTask(bloom);

    // 6. Image processing: ACES tone-mapping + exposure (HDR → LDR), applied once.
    const imageProcessing = new FrameGraphImageProcessingTask('imageProcessing', fg);
    imageProcessing.sourceTexture = bloom.outputTexture;
    const ipc = imageProcessing.postProcess.imageProcessingConfiguration;
    ipc.toneMappingEnabled = true;
    ipc.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ipc.exposure = 1.2;
    ipc.contrast = 1.0;
    fg.addTask(imageProcessing);

    // 7. FXAA (LDR).
    const fxaa = new FrameGraphFXAATask('fxaa', fg);
    fxaa.sourceTexture = imageProcessing.outputTexture;
    fg.addTask(fxaa);

    // 8. Sharpen (LDR).
    const sharpen = new FrameGraphSharpenTask('sharpen', fg);
    sharpen.sourceTexture = fxaa.outputTexture;
    sharpen.postProcess.edgeAmount = 0.1;
    sharpen.postProcess.colorAmount = 1.0;
    fg.addTask(sharpen);

    // 9. GUI / HUD overlay (crosshair, speed, perf) composited on top — scene.frameGraph bypasses
    // the normal scene layer pass, so the fullscreen GUI must be rendered as a graph task.
    const guiTask = new FrameGraphGUITask('gui', fg, options.gui);
    guiTask.targetTexture = sharpen.outputTexture;
    fg.addTask(guiTask);

    // 10. Present to the backbuffer.
    const copy = new FrameGraphCopyToBackbufferColorTask('copyToBackbuffer', fg);
    copy.sourceTexture = guiTask.outputTexture;
    fg.addTask(copy);

    // Build then install. Until the build resolves, scene.frameGraph stays null and scene.render()
    // falls back to the normal (post-less) render — a brief transient at startup.
    void fg.buildAsync().then(() => {
        scene.frameGraph = fg;
    });

    return {
        frameGraph: fg,
        dispose: () => {
            scene.frameGraph = null;
            fg.dispose();
        },
    };
}
