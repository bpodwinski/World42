import {
    Engine,
    Scene,
    Vector3,
    MeshBuilder,
    Color3,
    PointLight,
    Texture,
    PBRMetallicRoughnessMaterial,
    GlowLayer,
    Mesh,
    StandardMaterial,
    CubeTexture,
} from "@babylonjs/core";
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";

import { PostProcess } from "./utils/PostProcess";
import { StarGlare } from "./utils/SunGlare";
import { ScaleManager } from "./utils/ScaleManager";
import { FloatingEntity, OriginCamera } from "./utils/OriginCamera";
import { PlanetData } from "./utils/PlanetData";
import { AtmosphericScatteringPostProcess } from "./celestial/AtmosphericScatteringPostProcess";
import { Face, QuadTree } from "./celestial/quadtree/QuadTree";

/**
 * FloatingCameraScene creates and configures the scene with a floating-origin camera,
 * skybox, sun, and a CDLOD-based terrain system.
 */
export class FloatingCameraScene {
    /**
     * Creates a new Babylon.js scene configured with a floating-origin camera,
     * skybox, lighting, and terrain using a QuadTree system.
     *
     * @param engine - Babylon.js Engine instance
     * @param canvas - HTMLCanvasElement used for rendering
     * @returns The configured Scene instance
     */
    public static CreateScene(
        engine: Engine,
        canvas: HTMLCanvasElement
    ): Scene {
        // Initialize scene
        let scene = new Scene(engine);
        scene.clearColor.set(0, 0, 0, 1);
        scene.collisionsEnabled = true;
        scene.textures.forEach((texture) => {
            texture.anisotropicFilteringLevel = 16;
        });

        // Create an OriginCamera (a floating-origin UniversalCamera)
        // Uses double precision properties (doublepos and doubletgt) instead of standard position and target
        let planetTarget = PlanetData.get("Mercury").position.clone();
        planetTarget.x += ScaleManager.toSimulationUnits(-5000);
        planetTarget.y += ScaleManager.toSimulationUnits(2500);
        planetTarget.z += ScaleManager.toSimulationUnits(1000);

        let camera = new OriginCamera("camera", planetTarget, scene);
        camera.debugMode = false;
        camera.doubletgt = PlanetData.get("Mercury").position;

        camera.touchAngularSensibility = 300000;
        camera.inertia = 0.4;

        camera.speed = ScaleManager.toSimulationUnits(50);
        camera.keysUp.push(90); // Z
        camera.keysDown.push(83); // S
        camera.keysLeft.push(81); // Q
        camera.keysRight.push(68); // D
        camera.keysUpward.push(69); // A
        camera.keysDownward.push(65); // E
        camera.minZ = 0.001;
        camera.maxZ = 1_000_000_0;
        camera.fov = 1.8;
        camera.checkCollisions = true;
        camera.applyGravity = false;
        camera.ellipsoid = new Vector3(0.1, 0.1, 0.1);
        camera.attachControl(canvas, true);

        // Adjust camera speed with mouse wheel
        canvas.addEventListener(
            "wheel",
            function (e) {
                camera.speed = Math.min(
                    50,
                    Math.max(1, (camera.speed -= e.deltaY * 0.02))
                );
            },
            { passive: true }
        );

        new PostProcess("Pipeline", scene, camera);

        // Create skybox with cube texture
        const skybox = MeshBuilder.CreateBox(
            "skyBox",
            { size: 1_000_000_0 },
            scene
        );
        const skyboxMaterial = new StandardMaterial("skyBox", scene);
        skyboxMaterial.backFaceCulling = false;
        skyboxMaterial.disableLighting = true;
        skybox.material = skyboxMaterial;
        skybox.infiniteDistance = true;
        skyboxMaterial.reflectionTexture = new CubeTexture(
            "textures/skybox",
            scene
        );
        skyboxMaterial.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;

        // Create sun and associated lighting
        let entSunLight = new FloatingEntity("entSunLight", scene);
        entSunLight.doublepos.set(0, 0, 0);
        camera.add(entSunLight);

        let sunLight = new PointLight("sunLight", new Vector3(0, 0, 0), scene);
        sunLight.intensityMode = PointLight.INTENSITYMODE_LUMINOUSPOWER;
        sunLight.intensity = 37.5;
        sunLight.falloffType = PointLight.FALLOFF_STANDARD;
        sunLight.range = ScaleManager.toSimulationUnits(7e9);
        sunLight.diffuse = new Color3(1, 1, 1);
        sunLight.specular = new Color3(1, 1, 1);
        sunLight.radius = ScaleManager.toSimulationUnits(696340);
        sunLight.parent = entSunLight;

        const entSun = new FloatingEntity("entSun", scene);
        entSun.doublepos.set(0, 0, 0);
        camera.add(entSun);

        const sun = MeshBuilder.CreateSphere("sun", {
            segments: 64,
            diameter: PlanetData.get("Sun").diameter,
        });

        const starGlare = StarGlare.create(
            scene,
            sun,
            ScaleManager.toSimulationUnits(696340 * 2)
        );
        starGlare.start();

        const glowLayer = new GlowLayer("sunGlow", scene);
        glowLayer.addIncludedOnlyMesh(sun);

        /**
         * Updates the intensity of the sun's glow based on camera distance.
         */
        function updateGlowIntensity() {
            let cameraDistance = Vector3.Distance(
                camera.doublepos,
                PlanetData.get("Sun").position
            );

            glowLayer.intensity = Math.max(
                0.65,
                Math.min(1.2, cameraDistance / 15000)
            );

            glowLayer.blurKernelSize = Math.min(
                64,
                Math.max(
                    32,
                    32 + 32 * (1 - Math.min(1, cameraDistance / 20000))
                )
            );
        }

        let sunMaterial = new PBRMetallicRoughnessMaterial(
            "sunMaterial",
            scene
        );
        sunMaterial.emissiveTexture = new Texture(
            "sun/sun_surface_albedo.ktx2",
            scene
        );
        sunMaterial.emissiveColor = new Color3(1, 1, 1);
        sunMaterial.metallic = 0.0;
        sunMaterial.roughness = 0.0;
        sun.material = sunMaterial;
        sun.checkCollisions = true;
        sun.parent = entSun;

        // Create Mercury entity and attach it to the camera's hierarchy
        const entMercury = new FloatingEntity("entMercury", scene);
        entMercury.doublepos.set(
            PlanetData.get("Mercury").position._x,
            PlanetData.get("Mercury").position._y,
            PlanetData.get("Mercury").position._z
        );
        camera.add(entMercury);

        // Create QuadTree for Mercury on each cube face
        const faces: Face[] = [
            "front",
            "back",
            "left",
            "right",
            "top",
            "bottom",
        ];
        const maxLevel: number = 6;
        const radius: number =
            ScaleManager.toSimulationUnits(PlanetData.get("Mercury").diameter) /
            2;
        const resolution: number = 64;

        const mercury = faces.map(
            (face) =>
                new QuadTree(
                    scene,
                    camera,
                    { uMin: -1, uMax: 1, vMin: -1, vMax: 1 },
                    0,
                    maxLevel,
                    radius,
                    PlanetData.get("Mercury").position,
                    resolution,
                    face,
                    entMercury
                )
        );

        mercury.forEach((node) => {
            if (node.mesh) {
                node.mesh.parent = entMercury;
            }
        });

        // Athmos
        // const depthRenderer = scene.enableDepthRenderer(camera);
        // const atmosphereSettings = {
        //     rayleighHeight: 50,
        //     rayleighScatteringCoefficients: new Vector3(0.01, 0.015, 0.024),
        //     mieHeight: 40.0,
        //     mieScatteringCoefficients: new Vector3(0.001, 0.001, 0.0011),
        //     mieAsymmetry: 20.0,
        //     ozoneHeight: 45.0,
        //     ozoneAbsorptionCoefficients: new Vector3(0.001, 0.001, 0.0008),
        //     ozoneFalloff: 20.0,
        //     lightIntensity: 20.0,
        // };

        // const mercuryProxy = MeshBuilder.CreateSphere(
        //     "mercuryAtmosphere",
        //     { diameter: radius * 2 },
        //     scene
        // );
        // mercuryProxy.isVisible = false;
        // mercuryProxy.parent = entMercury;

        // const atmosphere = new AtmosphericScatteringPostProcess(
        //     "atmosphere",
        //     mercuryProxy,
        //     radius,
        //     radius + 500,
        //     sun,
        //     camera,
        //     depthRenderer,
        //     scene,
        //     atmosphereSettings
        // );

        // Map to store planet meshes (unused in current version)
        const planetMeshes = new Map<string, Mesh>();

        // Update loop before rendering
        scene.onBeforeRenderObservable.add(() => {
            updateGlowIntensity();
            StarGlare.updateParticleSize(
                camera.doublepos,
                PlanetData.get("Sun").position
            );

            sun.rotation.y += PlanetData.planets.Sun.rotationSpeed;
            // For Mercury, you could update rotation here if needed
        });

        // Asynchronous LOD update loop for QuadTree nodes (here, for Mercury)
        async function updateLODs() {
            while (true) {
                // Update LOD for each QuadTree node (Mercury)
                mercury.forEach((node) => {
                    node.updateLOD(camera, false).catch((err) =>
                        console.error(err)
                    );
                });
                // Wait for next frame to avoid saturating the CPU
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => resolve())
                );
            }
        }

        // Start LOD update loop
        updateLODs();

        // Main render loop
        engine.runRenderLoop(() => {
            scene.render();
        });

        return scene;
    }
}
