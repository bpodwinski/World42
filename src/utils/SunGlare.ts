import {
    Scene,
    Vector3,
    Texture,
    Color4,
    Mesh,
    ParticleSystem,
    SphereParticleEmitter,
    GPUParticleSystem,
} from "@babylonjs/core";

export class StarGlare {
    static particleSystem: GPUParticleSystem;

    /**
     * Creates a glare effect using a particle system.
     * @param scene - The js scene.
     * @param diameter - The diameter of the glare effect.
     * @returns The configured particle system.
     */
    public static create(
        scene: Scene,
        emitter: Mesh,
        diameter: number
    ): GPUParticleSystem {
        const particleSystem = new GPUParticleSystem(
            "starGlare",
            { capacity: 100 },
            scene
        );

        particleSystem.forceDepthWrite = true;
        particleSystem.isLocal = true;
        particleSystem.emitter = emitter;
        particleSystem.renderingGroupId = 1;
        particleSystem.particleEmitterType = new SphereParticleEmitter(
            diameter / 2,
            0
        );

        particleSystem.particleTexture = new Texture("T_Star.png", scene);

        particleSystem.minAngularSpeed = 0.01;
        particleSystem.maxAngularSpeed = 0.1;

        particleSystem.minSize = 10000;
        particleSystem.maxSize = 20000;

        particleSystem.minScaleX = 2.0;
        particleSystem.maxScaleX = 10.0;

        particleSystem.minScaleY = 1.0;
        particleSystem.maxScaleY = 13.0;

        particleSystem.minEmitPower = 0;
        particleSystem.maxEmitPower = 0;

        particleSystem.minLifeTime = 1;
        particleSystem.maxLifeTime = 2.5;

        particleSystem.emitRate = 200;
        particleSystem.updateSpeed = 0.002;
        particleSystem.targetStopDuration = 0;

        particleSystem.gravity = new Vector3(0, 0, 0);

        particleSystem.color1 = new Color4(1, 1, 1, 1);
        particleSystem.color2 = new Color4(1, 1, 1, 1);
        particleSystem.colorDead = new Color4(0, 0, 0, 1);

        particleSystem.blendMode = ParticleSystem.BLENDMODE_ADD;

        particleSystem.preWarmCycles = 0;
        particleSystem.preWarmStepOffset = 1;

        particleSystem.minInitialRotation = -Math.PI * 2;
        particleSystem.maxInitialRotation = Math.PI * 2;

        particleSystem.addColorGradient(0, new Color4(0.7, 0.7, 0.9, 0.01));
        particleSystem.addColorGradient(0.5, new Color4(0.7, 0.7, 0.95, 0.012));
        particleSystem.addColorGradient(1, new Color4(0.0, 0.0, 0.0, 0.01));

        particleSystem.textureMask = new Color4(1, 1, 1, 1);

        particleSystem.preventAutoStart = true;

        StarGlare.particleSystem = particleSystem;

        return particleSystem;
    }

    public static updateParticleSize(
        cameraPosition: Vector3,
        emitterPosition: Vector3
    ): void {
        let cameraDistance = Vector3.Distance(cameraPosition, emitterPosition);

        let newMinSize = Math.max(
            1_000_0,
            Math.min(5_000_0, cameraDistance / 5)
        );
        let newMaxSize = Math.max(
            2_000_0,
            Math.min(1_000_00, cameraDistance / 5)
        );

        StarGlare.particleSystem.minSize = newMinSize;
        StarGlare.particleSystem.maxSize = newMaxSize;
    }
}
