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
import { FrameGraphTerrainComputeTask } from './terrain_compute_task';
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
import {
    setAtmosphereUniforms,
    ATMO_PP_FRAGMENT,
    ATMO_PP_SAMPLERS,
    ATMO_PP_UNIFORMS,
    type AtmosphereSource,
} from './atmosphere_postprocess';
import {
    FrameGraphFsr1EasuTask,
    FrameGraphFsr1RcasTask,
    fsr1RenderPercent,
    FSR1_FULLRES_RTT_OPTIONS,
    type Fsr1Options,
} from './fsr1_postprocess';

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
            shaderLanguage: ShaderLanguage.WGSL,
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

/**
 * Frame Graph custom task for the single-scattering atmosphere pass. Reads scene color
 * (sourceTexture = `textureSampler`) and sets all uniforms per-frame in `onBindObservable` from the
 * nearest atmosphere source. The surface is bounded analytically (planet sphere) so it does NOT
 * sample scene depth. When no source is active the shader passes the scene through (sunIntensity = 0).
 */
class FrameGraphAtmosphereTask extends FrameGraphPostProcessTask {
    constructor(
        name: string,
        frameGraph: FrameGraph,
        scene: Scene,
        camera: OriginCamera,
        sources: AtmosphereSource[]
    ) {
        const engine = frameGraph.engine;
        const pp = new ThinCustomPostProcess(name, engine, {
            name,
            engine,
            fragmentShader: ATMO_PP_FRAGMENT,
            useShaderStore: false,
            uniformNames: [...ATMO_PP_UNIFORMS],
            samplerNames: [...ATMO_PP_SAMPLERS],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        super(name, frameGraph, pp);
        pp.onBindObservable.add((effect: Effect) => {
            setAtmosphereUniforms(effect, scene, camera, sources);
        });
    }
}

export type FrameGraphHandle = {
    frameGraph: FrameGraph;
    dispose: () => void;
};

export type FrameGraphOptions = {
    stars: StarGlowSource[];
    occluders?: StarOccluder[];
    /** Atmospheric planets (single-scattering pass). Empty => the atmosphere task is not added. */
    atmospheres: AtmosphereSource[];
    /** Fullscreen GUI texture (must be created with useStandalone: true) for the HUD overlay. */
    gui: AdvancedDynamicTexture;
    /** Drives the TERRAIN terrain compute as a graph task (runs before the scene-render task). */
    runCompute: () => void;
    /** Called once the graph is built and installed, so the caller can hand compute ownership to it. */
    onGraphReady?: () => void;
    /**
     * FSR1 spatial upscaling. When provided the scene is rendered at
     * `renderScale` fraction of display resolution and upscaled to full-res
     * via EASU + RCAS. Omit to keep the native-resolution pipeline.
     */
    fsr1?: Fsr1Options;
};

/**
 * Builds the World42 render pipeline as a Babylon Frame Graph and installs it on the scene.
 *
 * Replaces the imperative camera post-process stack (DefaultRenderingPipeline + TAA pipeline +
 * star post-process). The graph governs ONLY the render passes; the TERRAIN compute, floating-origin
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

    // Full-screen HDR color + depth render targets. SINGLE-SAMPLE: geometric edge AA is handled by
    // the always-on TAA (16x) + FXAA below, not MSAA. Reason we dropped MSAA: WebGPU cannot resolve
    // a DEPTH attachment via a render-pass resolveTarget, so Babylon resolved the MSAA depth with a
    // COMPUTE shader whose bind-group layout is invalid (multisampled depth declared sampleType Float)
    // — 7 validation errors/frame AND a garbage resolved depth (star terrain-occlusion broken).
    // Single-sample depth is sampled directly by the star, so there is nothing to resolve.
    //
    // When FSR1 is active, sceneColor and sceneDepth are created at renderScale% of the canvas so
    // that all intermediate passes run at the lower resolution. FSR1 EASU + RCAS upscale to 100%.
    const MSAA_SAMPLES = 1;
    const renderPct = options.fsr1 ? fsr1RenderPercent(options.fsr1.renderScale) : 100;
    const sceneColor = tm.createRenderTargetTexture('sceneColor', {
        size: renderPct,
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            samples: MSAA_SAMPLES,
            types: [Constants.TEXTURETYPE_HALF_FLOAT],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            labels: ['sceneColor'],
        },
    });
    const sceneDepth = tm.createRenderTargetTexture('sceneDepth', {
        size: renderPct,
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            samples: MSAA_SAMPLES,
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

    // 1b. TERRAIN terrain compute (topology + EvaluateLEB + draw compaction). MUST be added before the
    // scene-render task: it writes the storage buffers that task's vertex shader reads, and the graph
    // orders tasks only by texture dependencies (it cannot see the storage-buffer handoff), so task
    // order is the contract. Both record into the same WebGPU command encoder → dispatch before draw.
    const terrainCompute = new FrameGraphTerrainComputeTask('terrainCompute', fg, options.runCompute);
    fg.addTask(terrainCompute);

    // 2. Render the scene meshes (TERRAIN terrain + skybox) into HDR color + depth.
    const objRenderer = new FrameGraphObjectRendererTask('sceneRender', fg, scene, {});
    objRenderer.camera = camera;
    objRenderer.targetTexture = clear.outputTexture;
    objRenderer.depthTexture = clear.outputDepthTexture;
    objRenderer.isMainObjectRenderer = true;
    objRenderer.disableImageProcessing = true; // tonemap is a dedicated task AFTER bloom
    objRenderer.resolveMSAAColors = false; // single-sample: nothing to resolve
    objRenderer.resolveMSAADepth = false; // single-sample: star samples sceneDepth directly
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

    // 3b. Atmosphere (single-scattering, HDR) — only when the scene has atmospheric bodies. Reads the
    // star output + scene depth (aerial perspective). Output feeds TAA; otherwise TAA reads star.
    let preTaaColor = star.outputTexture;
    if (options.atmospheres.length > 0) {
        const atmo = new FrameGraphAtmosphereTask('atmosphere', fg, scene, camera, options.atmospheres);
        atmo.sourceTexture = star.outputTexture;
        fg.addTask(atmo);
        preTaaColor = atmo.outputTexture;
    }

    // 4. TAA — ALWAYS ON (also while the camera moves). No reprojection (PrePass/velocity is
    // incompatible with the TERRAIN GPU mesh + log depth), so the 3x3 neighborhood clamp (clampHistory)
    // is what suppresses ghosting/smear during motion. MSAA above handles geometric edges so TAA can
    // stay light. If motion ghosting is too strong, re-enable disableOnCameraMove or lower samples.
    const taa = new FrameGraphTAATask('taa', fg);
    taa.sourceTexture = preTaaColor;
    taa.objectRendererTask = objRenderer;
    taa.postProcess.samples = 16;
    taa.postProcess.disableOnCameraMove = true; // always accumulate
    taa.postProcess.reprojectHistory = false;
    taa.postProcess.clampHistory = true; // neighborhood clamp limits motion ghosting
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

    // 8. Sharpen (LDR) — skipped when FSR1 is active (RCAS handles sharpening at full-res).
    let preGuiTexture: FrameGraphTextureHandle;
    if (!options.fsr1) {
        const sharpen = new FrameGraphSharpenTask('sharpen', fg);
        sharpen.sourceTexture = fxaa.outputTexture;
        sharpen.postProcess.edgeAmount = 0.1;
        sharpen.postProcess.colorAmount = 1.0;
        fg.addTask(sharpen);
        preGuiTexture = sharpen.outputTexture;
    } else {
        // 8b. FSR1 EASU: upscale from renderScale% → 100%.
        // A dedicated full-res RTT is created so subsequent passes (RCAS, GUI) run at canvas size.
        const fsr1Color = tm.createRenderTargetTexture('fsr1Color', {
            size: 100,
            sizeIsPercentage: true,
            options: FSR1_FULLRES_RTT_OPTIONS,
        });
        const fsr1Easu = new FrameGraphFsr1EasuTask('fsr1Easu', fg, options.fsr1.renderScale);
        fsr1Easu.sourceTexture = fxaa.outputTexture;
        // EASU must output a full-res (100%) RTT to upscale the renderScale% scene. Babylon types
        // `outputTexture` as readonly, but assigning a target output is the supported runtime pattern
        // (the auto-created output would inherit the smaller input size). Type-only cast.
        (fsr1Easu as { outputTexture: typeof fsr1Color }).outputTexture = fsr1Color;
        fg.addTask(fsr1Easu);

        // 8c. FSR1 RCAS: adaptive sharpening at full resolution.
        const fsr1Rcas = new FrameGraphFsr1RcasTask(
            'fsr1Rcas',
            fg,
            options.fsr1.sharpness ?? 0.2
        );
        fsr1Rcas.sourceTexture = fsr1Easu.outputTexture;
        fg.addTask(fsr1Rcas);
        preGuiTexture = fsr1Rcas.outputTexture;
    }

    // 9. GUI / HUD overlay (crosshair, speed, perf) composited on top — scene.frameGraph bypasses
    // the normal scene layer pass, so the fullscreen GUI must be rendered as a graph task.
    const guiTask = new FrameGraphGUITask('gui', fg, options.gui);
    guiTask.targetTexture = preGuiTexture;
    fg.addTask(guiTask);

    // 10. Present to the backbuffer.
    const copy = new FrameGraphCopyToBackbufferColorTask('copyToBackbuffer', fg);
    copy.sourceTexture = guiTask.outputTexture;
    fg.addTask(copy);

    // Build then install. Until the build resolves, scene.frameGraph stays null and scene.render()
    // falls back to the normal (post-less) render — a brief transient at startup.
    void fg.buildAsync().then(() => {
        scene.frameGraph = fg;
        // Graph (and its TERRAIN compute task) is now live — hand the heavy compute loop to the task so it
        // stops running in the startup observer (no double-tick). Runs in a microtask before the next
        // scene.render(), so there is no frame where both drive the compute.
        options.onGraphReady?.();
    });

    return {
        frameGraph: fg,
        dispose: () => {
            scene.frameGraph = null;
            fg.dispose();
        },
    };
}
