import {
    Constants,
    FrameGraph,
    FrameGraphPostProcessTask,
    ShaderLanguage,
    type Effect,
} from '@babylonjs/core';
import { ThinCustomPostProcess } from '@babylonjs/core/PostProcesses/thinCustomPostProcess';
import fsr1EasuShader from '../../assets/shaders/fsr1/fsr1_easu.wgsl';
import fsr1RcasShader from '../../assets/shaders/fsr1/fsr1_rcas.wgsl';

/** Canonical render-scale presets matching AMD FSR1 quality tiers. */
export const FSR1_QUALITY_MODES = {
    Quality: 0.667,
    Balanced: 0.75,
    Performance: 0.5,
} as const;

export type Fsr1Options = {
    /** Fraction of display resolution used for rendering. Default: Quality (0.667). */
    renderScale: number;
    /** RCAS sharpness: 0.0 = maximum, 2.0 = off. Default: 0.2. */
    sharpness?: number;
};

const EASU_UNIFORMS = ['inputSize', 'outputSize'] as const;
const EASU_SAMPLERS: string[] = [];

const RCAS_UNIFORMS = ['inputSize', 'rcasSharpness'] as const;
const RCAS_SAMPLERS: string[] = [];

/**
 * Frame Graph task for the FSR1 EASU upscaling pass.
 * Reads the low-resolution scene color and writes a full-resolution upscaled image.
 *
 * @param renderScale - fraction of display resolution the scene was rendered at (e.g. 0.667).
 *   Used to compute inputSize each frame from the engine's current canvas dimensions.
 */
export class FrameGraphFsr1EasuTask extends FrameGraphPostProcessTask {
    constructor(name: string, frameGraph: FrameGraph, renderScale: number) {
        const engine = frameGraph.engine;
        const pp = new ThinCustomPostProcess(name, engine, {
            name,
            engine,
            fragmentShader: fsr1EasuShader,
            useShaderStore: false,
            uniformNames: [...EASU_UNIFORMS],
            samplerNames: [...EASU_SAMPLERS],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        super(name, frameGraph, pp);

        pp.onBindObservable.add((effect: Effect) => {
            // Full canvas dimensions (display resolution).
            const outW = engine.getRenderWidth(true);
            const outH = engine.getRenderHeight(true);
            // Low-res input matches what the frame graph created at renderScale%.
            const inW = Math.round(outW * renderScale);
            const inH = Math.round(outH * renderScale);
            effect.setFloat2('inputSize', inW, inH);
            effect.setFloat2('outputSize', outW, outH);
        });
    }
}

/**
 * Frame Graph task for the FSR1 RCAS sharpening pass.
 * Reads the full-resolution EASU output and applies contrast-adaptive sharpening.
 */
export class FrameGraphFsr1RcasTask extends FrameGraphPostProcessTask {
    constructor(name: string, frameGraph: FrameGraph, sharpness = 0.2) {
        const engine = frameGraph.engine;
        const pp = new ThinCustomPostProcess(name, engine, {
            name,
            engine,
            fragmentShader: fsr1RcasShader,
            useShaderStore: false,
            uniformNames: [...RCAS_UNIFORMS],
            samplerNames: [...RCAS_SAMPLERS],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        super(name, frameGraph, pp);

        pp.onBindObservable.add((effect: Effect) => {
            // Input is the full-res EASU output — matches canvas dimensions.
            const inW = engine.getRenderWidth(true);
            const inH = engine.getRenderHeight(true);
            effect.setFloat2('inputSize', inW, inH);
            effect.setFloat('rcasSharpness', sharpness);
        });
    }
}

/** Render-target size percentage for a given FSR1 render scale (e.g. 0.667 → 67). */
export function fsr1RenderPercent(renderScale: number): number {
    return Math.round(renderScale * 100);
}

/** LDR half-float render target options for the full-res FSR1 intermediate texture. */
export const FSR1_FULLRES_RTT_OPTIONS = {
    createMipMaps: false,
    samples: 1,
    types: [Constants.TEXTURETYPE_HALF_FLOAT],
    formats: [Constants.TEXTUREFORMAT_RGBA],
    labels: ['fsr1Color'],
} as const;
