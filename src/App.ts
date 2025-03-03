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

import { StarGlare } from "./utils/SunGlare";
import { ScaleManager } from "./utils/ScaleManager";
import { PlanetData } from "./celestial/PlanetData";
import { FloatingEntity, OriginCamera } from "./utils/OriginCamera";
import { PostProcess } from "./utils/PostProcess";
import { AtmosphericScatteringPostProcess } from "./celestial/AtmosphericScatteringPostProcess";
import { Face, QuadTree } from "./celestial/quadtree/QuadTree";
import { QuadTreePool } from "./celestial/quadtree/QuadTreePool";

export class FloatingCameraScene {
    public static CreateScene(
        engine: Engine,
        canvas: HTMLCanvasElement
    ): Scene {
        // Scene Init
        let scene = new Scene(engine);
        scene.clearColor.set(0, 0, 0, 1);
        scene.collisionsEnabled = true;
        scene.textures.forEach((texture) => {
            texture.anisotropicFilteringLevel = 16;
        });

        // Create an OriginCamera, which is a special floating-origin UniversalCamera
        // It works much like UniversalCamera, but we use its doublepos and doubletgt
        // properties instead of position and target
        let planetTarget = PlanetData.get("Mercury").position.clone();
        planetTarget.x += ScaleManager.toSimulationUnits(-5_000);
        planetTarget.y += ScaleManager.toSimulationUnits(2_500);
        planetTarget.z += ScaleManager.toSimulationUnits(1_000);

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

        // Skybox
        const skybox = MeshBuilder.CreateBox(
            "skyBox",
            { size: 9_000_000_00 },
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

        // Sun
        let entSunLight = new FloatingEntity("entSunLight", scene);
        entSunLight.doublepos.set(0, 0, 0);
        camera.add(entSunLight);

        let sunLight = new PointLight("sunLight", new Vector3(0, 0, 0), scene);

        sunLight.intensityMode = PointLight.INTENSITYMODE_LUMINOUSPOWER;
        sunLight.intensity = 3.75e1;
        sunLight.falloffType = PointLight.FALLOFF_STANDARD;
        sunLight.range = ScaleManager.toSimulationUnits(7e9);
        sunLight.diffuse = new Color3(1, 1, 1);
        sunLight.specular = new Color3(1, 1, 1);
        sunLight.radius = ScaleManager.toSimulationUnits(696_340);
        sunLight.parent = entSunLight;

        const entSun = new FloatingEntity("entSun", scene);
        entSun.doublepos.set(0, 0, 0);
        camera.add(entSun);

        const sun = MeshBuilder.CreateSphere("sun", {
            segments: 128,
            diameter: PlanetData.get("Sun").diameter,
        });

        const starGlare = StarGlare.create(
            scene,
            sun,
            ScaleManager.toSimulationUnits(696_340 * 2)
        );
        starGlare.start();

        const glowLayer = new GlowLayer("sunGlow", scene);
        glowLayer.addIncludedOnlyMesh(sun);

        function updateGlowIntensity() {
            let cameraDistance = Vector3.Distance(
                camera.doublepos,
                PlanetData.get("Sun").position
            );

            glowLayer.intensity = Math.max(
                0.65,
                Math.min(1.2, cameraDistance / 15_000)
            );

            glowLayer.blurKernelSize = Math.min(
                64,
                Math.max(
                    32,
                    32 + 32 * (1 - Math.min(1, cameraDistance / 20_000))
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

        // Mercury
        const entMercury = new FloatingEntity("entMercury", scene);
        entMercury.doublepos.set(
            PlanetData.get("Mercury").position._x,
            PlanetData.get("Mercury").position._y,
            PlanetData.get("Mercury").position._z
        );
        camera.add(entMercury);

        const faces: Face[] = [
            "front",
            "back",
            "left",
            "right",
            "top",
            "bottom",
        ];
        const maxLevel: number = 7;
        const radius: number =
            ScaleManager.toSimulationUnits(PlanetData.get("Mercury").diameter) /
            2;
        const resolution: number = 128;

        const quadTreePool = new QuadTreePool(250);
        const mercury = faces.map(
            (face) =>
                new QuadTree(
                    scene,
                    camera,
                    { uMin: -1, uMax: 1, vMin: -1, vMax: 1 },
                    0,
                    maxLevel,
                    radius,
                    resolution,
                    face,
                    quadTreePool,
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
        //     rayleighHeight: 20,
        //     rayleighScatteringCoefficients: new Vector3(0.0032, 0.001, 0.0003),
        //     mieHeight: 15.0,
        //     mieScatteringCoefficients: new Vector3(0.00032, 0.0001, 0.00001),
        //     mieAsymmetry: 25.0,
        //     ozoneHeight: 0.1,
        //     ozoneAbsorptionCoefficients: new Vector3(0.0, 0.0, 0.0),
        //     ozoneFalloff: 15.0,
        //     lightIntensity: 5.0,
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

        // Créer une Map pour stocker les Meshes des planètes
        const planetMeshes = new Map<string, Mesh>();

        scene.onBeforeRenderObservable.add(() => {
            updateGlowIntensity();
            StarGlare.updateParticleSize(
                camera.doublepos,
                PlanetData.get("Sun").position
            );

            sun.rotation.y += PlanetData.planets.Sun.rotationSpeed;
            //mercury.rotation.y += PlanetData.planets.Mercury.rotationSpeed;
        });

        // Fonction asynchrone pour mettre à jour les LOD en boucle
        async function updateLODs() {
            while (true) {
                // Mettre à jour les LOD pour chaque node (ici, 'mercury')
                mercury.forEach((node) => {
                    node.updateLOD(camera, false).catch((err) =>
                        console.error(err)
                    );
                });
                // Attendre la prochaine frame pour ne pas saturer le CPU
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(resolve)
                );
            }
        }

        // Lancer la boucle d'update dédiée
        updateLODs();

        // Boucle de rendu principale
        engine.runRenderLoop(() => {
            scene.render();
        });

        return scene;
    }
}
