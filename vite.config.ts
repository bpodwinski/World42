import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
    base: "/World42/",
    plugins: [
        glsl({
            include: ["**/*.glsl", "**/*.wgsl"],
            watch: true,
        }),
    ],
    server: {
        port: 3000,
    },
});
