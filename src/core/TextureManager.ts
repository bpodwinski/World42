import { Scene, Texture } from "@babylonjs/core";

/**
 * TextureManager extends the Babylon.js Texture class
 *
 * Loads a texture from a default base URL using the provided texture file name
 * You can directly use instances of TextureManager as textures
 */
export class TextureManager extends Texture {
    /**
     * Creates a new TextureManager instance
     *
     * @param textureName - The file name of the texture to load
     * @param scene - Babylon.js scene used for texture loading
     */
    constructor(textureName: string, scene: Scene) {
        const baseURL = import.meta.env.VITE_ASSETS_URL;
        const textureURL = `${baseURL}/${textureName}`;

        super(textureURL, scene);
    }
}
