import type { Scene } from "@babylonjs/core";
import {
    CubeTexture,
    MeshBuilder,
    StandardMaterial,
    Texture,
} from "@babylonjs/core";

export type SkyboxOptions = {
    /** CubeTexture root url (ex: `${process.env.ASSETS_URL}/skybox`) */
    url: string;
    size?: number;
    name?: string;
    renderingGroupId?: number;
};

/**
 * Core factory: create a standard skybox (reusable across screens).
 */
export function createSkybox(scene: Scene, opts: SkyboxOptions) {
    const name = opts.name ?? "skyBox";
    const size = opts.size ?? 1000;
    const renderingGroupId = opts.renderingGroupId ?? 0;

    const skybox = MeshBuilder.CreateBox(name, { size }, scene);
    skybox.isPickable = false;
    skybox.infiniteDistance = true;
    skybox.renderingGroupId = renderingGroupId;

    const mat = new StandardMaterial(`${name}Material`, scene);
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    mat.disableDepthWrite = true;

    const tex = new CubeTexture(opts.url, scene);
    tex.coordinatesMode = Texture.SKYBOX_MODE;

    mat.reflectionTexture = tex;
    skybox.material = mat;

    return skybox;
}
