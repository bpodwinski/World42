import { Effect, Matrix, PostProcess, Vector2, Vector3, Scene } from "@babylonjs/core";
import type { OriginCamera } from "../camera/camera_manager";
import starRayMarchingFragmentShader from "../../assets/shaders/stars/starRayMarchingFragmentShader.glsl";

export type StarGlowSource = {
    posWorldDouble: Vector3;
    radius: number;
    color: Vector3;
    intensity: number;
};

function pickNearestStar(camWorldDouble: Vector3, stars: StarGlowSource[]): StarGlowSource | null {
    if (!stars.length) return null;
    let best = stars[0];
    let bestD2 = Vector3.DistanceSquared(camWorldDouble, best.posWorldDouble);
    for (let i = 1; i < stars.length; i++) {
        const s = stars[i];
        const d2 = Vector3.DistanceSquared(camWorldDouble, s.posWorldDouble);
        if (d2 < bestD2) {
            best = s;
            bestD2 = d2;
        }
    }
    return best;
}

export function attachStarRayMarchingPostProcess(
    scene: Scene,
    camera: OriginCamera,
    stars: StarGlowSource[]
): PostProcess {
    // PostProcess name "starRayMarching" => expects key "starRayMarchingFragmentShader"
    Effect.ShadersStore["starRayMarchingFragmentShader"] = starRayMarchingFragmentShader;

    const pp = new PostProcess(
        "starRayMarchingPP",
        "starRayMarching",
        [
            "resolution",
            "time",
            "cameraPositionRender",
            "starCenterRender",
            "starRadius",
            "tMax",
            "starColor",
            "starIntensity",
            "inverseProjection",
            "inverseView",
        ],
        null,
        1,
        camera
    );

    // Reuse allocations
    const starCenterRender = new Vector3();
    const res = new Vector2();
    const invProj = new Matrix();
    const invView = new Matrix();

    pp.onApply = (effect) => {
        const engine = scene.getEngine();

        // REQUIRED uniforms
        res.set(engine.getRenderWidth(), engine.getRenderHeight());
        effect.setVector2("resolution", res);
        effect.setFloat("time", performance.now() * 0.001);

        camera.getProjectionMatrix().invertToRef(invProj);
        camera.getViewMatrix().invertToRef(invView);
        effect.setMatrix("inverseProjection", invProj);
        effect.setMatrix("inverseView", invView);

        // Render-space camera origin
        effect.setVector3("cameraPositionRender", camera.position);

        const star = pickNearestStar(camera.doublepos, stars);
        if (star) {
            camera.toRenderSpace(star.posWorldDouble, starCenterRender);
            effect.setVector3("starCenterRender", starCenterRender);

            effect.setFloat("starRadius", star.radius);

            const dist = starCenterRender.length();
            effect.setFloat("tMax", dist + star.radius * 2.0 + 1000.0);

            effect.setVector3("starColor", star.color);
            effect.setFloat("starIntensity", star.intensity);
        } else {
            // Safe defaults (avoid NaNs)
            effect.setVector3("starCenterRender", new Vector3(1e12, 1e12, 1e12));
            effect.setFloat("starRadius", 1.0);
            effect.setFloat("tMax", 1.0);
            effect.setVector3("starColor", new Vector3(1, 1, 1));
            effect.setFloat("starIntensity", 0.0);
        }
    };

    return pp;
}
