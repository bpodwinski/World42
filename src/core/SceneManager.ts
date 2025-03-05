import { Engine, Scene } from "@babylonjs/core";

/**
 * SceneManager handles the creation and switching between scenes
 *
 * Centralizes scene management and ensures proper disposal of previous scenes
 */
export class SceneManager {
    private engine: Engine;
    private currentScene: Scene | null = null;

    /**
     * Creates a new SceneManager instance with the given engine
     *
     * @param engine - Babylon.js engine used for scene creation and rendering
     */
    constructor(engine: Engine) {
        this.engine = engine;
    }

    /**
     * Creates a new scene using the provided callback
     *
     * Disposes the current scene (if any) before setting the new scene
     *
     * @param createSceneCallback - Function that creates and returns a new Scene instance
     * @returns The newly created Scene
     */
    public createScene(createSceneCallback: (engine: Engine) => Scene): Scene {
        if (this.currentScene) {
            this.currentScene.dispose();
        }
        this.currentScene = createSceneCallback(this.engine);
        return this.currentScene;
    }

    /**
     * Switches to a new scene using the provided callback
     *
     * Automatically disposes the old scene and sets the new one as active
     *
     * @param createSceneCallback - Function that creates and returns a new Scene instance
     * @returns The newly created Scene
     */
    public switchScene(createSceneCallback: (engine: Engine) => Scene): Scene {
        return this.createScene(createSceneCallback);
    }

    /**
     * Returns the current active scene
     *
     * @returns The current Scene instance or null if none is set
     */
    public getCurrentScene(): Scene | null {
        return this.currentScene;
    }
}
