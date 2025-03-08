import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig(({ command, mode }) => {
    return {
        base: "/World42/",
        server: {
            port: 3000,
        },
        plugins: [
            glsl({
                include: ["**/*.glsl", "**/*.wgsl"],
                watch: true,
            }),
        ],
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
