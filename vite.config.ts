import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig(({ command, mode }) => {
    return {
        base: "/World42/",
        plugins: [glsl()],
        resolve: {
            alias: {
                babylonjs:
                    mode === "development"
                        ? "babylonjs/babylon.max"
                        : "babylonjs",
            },
        },
        server: {
            proxy: {
                "/BabylonAssets": {
                    target: "https://benoitpodwinski.com",
                    changeOrigin: true,
                    rewrite: (path) =>
                        path.replace(/^\/BabylonAssets/, "/BabylonAssets"),
                },
            },
        },
    };
});
