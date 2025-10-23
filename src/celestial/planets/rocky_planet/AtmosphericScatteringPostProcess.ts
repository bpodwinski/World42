import {
    Effect,
    PostProcess,
    Camera,
    TransformNode,
    Light,
    DepthRenderer,
    Mesh,
    Scene,
    Texture,
    Matrix
} from '@babylonjs/core';

import { AtmosphericScatteringSettings } from '../../../types/AtmosphericScatteringPostProcessTypes';

import atmosphereFragmentShader from '../shaders/atmosphericScatteringFragmentShader.glsl';
import { OriginCamera } from '../../../engine/core/CameraManager';

const SHADER_UNIFORMS = [
    'logarithmicDepthConstant',
    'sunPosition',
    'cameraPosition',
    'inverseProjection',
    'inverseView',
    'cameraNear',
    'cameraFar',
    'planetPosition',
    'planetRadius',
    'atmosphereRadius',
    'rayleighHeight',
    'rayleighCoeffs',
    'mieHeight',
    'mieCoeffs',
    'mieAsymmetry',
    'ozoneHeight',
    'ozoneCoeffs',
    'ozoneFalloff',
    'sunIntensity'
];

const SHADER_SAMPLERS = ['textureSampler', 'depthSampler'];

Effect.ShadersStore['atmosphereFragmentShader'] = atmosphereFragmentShader;

export class AtmosphericScatteringPostProcess extends PostProcess {
    settings: AtmosphericScatteringSettings;
    camera: OriginCamera;
    sun: TransformNode | Light;
    planet: TransformNode;
    depthRenderer: DepthRenderer;

    constructor(
        name: string,
        planet: Mesh,
        planetRadius: number,
        atmosphereRadius: number,
        sun: TransformNode | Light,
        camera: OriginCamera,
        depthRenderer: DepthRenderer,
        scene: Scene,
        settings: AtmosphericScatteringSettings
    ) {
        super(
            name,
            'atmosphere',
            SHADER_UNIFORMS,
            SHADER_SAMPLERS,
            1,
            camera,
            Texture.BILINEAR_SAMPLINGMODE,
            scene.getEngine(),
            false
        );

        this.settings = settings;
        this.camera = camera;
        this.sun = sun;
        this.planet = planet;
        this.depthRenderer = depthRenderer;

        this.onApplyObservable.add((effect: Effect) => {
            if (this.depthRenderer.getDepthMap()) {
                effect.setTexture(
                    'depthSampler',
                    this.depthRenderer.getDepthMap()
                );
            }

            effect.setVector3('sunPosition', this.sun.getAbsolutePosition());
            effect.setVector3('cameraPosition', this.camera.position);
            effect.setVector3('planetPosition', this.planet.absolutePosition);

            effect.setMatrix(
                'inverseProjection',
                Matrix.Invert(this.camera.getProjectionMatrix())
            );
            effect.setMatrix(
                'inverseView',
                Matrix.Invert(this.camera.getViewMatrix())
            );

            effect.setFloat('cameraNear', camera.minZ);
            effect.setFloat('cameraFar', camera.maxZ);

            effect.setFloat('planetRadius', planetRadius);
            effect.setFloat('atmosphereRadius', atmosphereRadius);

            effect.setFloat('rayleighHeight', this.settings.rayleighHeight);
            effect.setVector3(
                'rayleighCoeffs',
                this.settings.rayleighScatteringCoefficients
            );

            effect.setFloat('mieHeight', this.settings.mieHeight);
            effect.setVector3(
                'mieCoeffs',
                this.settings.mieScatteringCoefficients
            );
            effect.setFloat('mieAsymmetry', this.settings.mieAsymmetry);

            effect.setFloat('ozoneHeight', this.settings.ozoneHeight);
            effect.setVector3(
                'ozoneCoeffs',
                this.settings.ozoneAbsorptionCoefficients
            );
            effect.setFloat('ozoneFalloff', this.settings.ozoneFalloff);

            effect.setFloat('sunIntensity', this.settings.lightIntensity);
        });
    }
}
