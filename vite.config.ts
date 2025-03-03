import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig(({ command, mode }) => {
    return {
        base: "/project42/",
        plugins: [glsl()],
        resolve: {
            alias: {
                babylonjs:
                    mode === "development"
                        ? "babylonjs/babylon.max"
                        : "babylonjs",
            },
        },
    };
});
