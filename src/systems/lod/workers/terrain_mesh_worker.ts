/// <reference lib="webworker" />

import type { MeshKernelRequest, MeshKernelResponse, MeshKernelBuildChunkRequest } from "./worker-protocol";
import { MESH_KERNEL_PROTOCOL } from "./worker-protocol";

// IMPORTANT: importer le glue JS, pas le .wasm
import initWasm, { build_chunk } from "../../../../terrain/pkg/mesh_kernel_wasm.js";

const PROTOCOL = MESH_KERNEL_PROTOCOL;

let wasmReady: Promise<void> | null = null;

function ensureWasmReady() {
    if (!wasmReady) {
        const wasmUrl = new URL(
            "../../../../terrain/pkg/mesh_kernel_wasm_bg.wasm",
            import.meta.url
        );
        wasmReady = (initWasm as any)(wasmUrl);
    }
    return wasmReady;
}

let currentJobId: string | null = null;
let cancelCurrent = false;

function post(msg: MeshKernelResponse, transfer?: Transferable[]) {
    (self as any).postMessage(msg, transfer ?? []);
}

(self as any).onmessage = async (event: MessageEvent<MeshKernelRequest | any>) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object" || msg.protocol !== PROTOCOL) return;

    if (msg.kind === "init") {
        try {
            await ensureWasmReady();
            post({
                protocol: PROTOCOL,
                kind: "ready",
                id: msg.id,
                payload: { impl: "wasm", meshFormats: ["typed", "arrays"] },
            });
        } catch (e: any) {
            post({
                protocol: PROTOCOL,
                kind: "error",
                id: msg.id,
                payload: { code: "wasm_init_failed", message: String(e?.message ?? e) },
            });
        }
        return;
    }

    if (msg.kind === "cancel") {
        const cancelId = msg.payload?.cancelId;
        if (cancelId && currentJobId === cancelId) cancelCurrent = true;
        return;
    }

    if (msg.kind !== "build_chunk") {
        post({
            protocol: PROTOCOL,
            kind: "error",
            id: msg.id ?? "unknown",
            payload: { code: "bad_request", message: "Unknown message kind" },
        });
        return;
    }

    const req = msg as MeshKernelBuildChunkRequest;
    const id = req.id;
    const p = req.payload;

    const start = performance.now();

    try {
        await ensureWasmReady();

        currentJobId = id;
        cancelCurrent = false;

        const seed = (p.noise?.seed ?? 1) | 0;
        const octaves = p.noise?.octaves ?? 8;
        const baseFrequency = p.noise?.baseFrequency ?? 1.0;
        const baseAmplitude = p.noise?.baseAmplitude ?? 4.0;
        const lacunarity = p.noise?.lacunarity ?? 2.5;
        const persistence = p.noise?.persistence ?? 0.5;
        const globalAmp = p.noise?.globalTerrainAmplitude ?? 100.0;

        // NOTE: cast any pour ne pas bloquer sur l’arity tant que Rust n’est pas figé
        const meshData: any = (build_chunk as any)(
            p.bounds.uMin,
            p.bounds.uMax,
            p.bounds.vMin,
            p.bounds.vMax,
            p.resolution,
            p.radius,
            p.face,
            //p.level,      // <= ajoute ça (probable arg manquant)
            seed,
            octaves,
            baseFrequency,
            baseAmplitude,
            lacunarity,
            persistence,
            globalAmp
        );

        if (cancelCurrent) {
            post({
                protocol: PROTOCOL,
                kind: "error",
                id,
                payload: { code: "cancelled", message: "Job cancelled" },
            });
            return;
        }

        const stats = {
            ms: performance.now() - start,
            vertexCount: (meshData.positions.length / 3) | 0,
            indexCount: (meshData.indices.length) | 0,
        };

        const meshFormat = p.meshFormat ?? "typed";
        if (meshFormat === "arrays") {
            post({
                protocol: PROTOCOL,
                kind: "chunk_result",
                id,
                payload: {
                    meshData: {
                        ...meshData,
                        positions: Array.from(meshData.positions),
                        normals: Array.from(meshData.normals),
                        uvs: Array.from(meshData.uvs),
                        indices: Array.from(meshData.indices),
                    },
                    stats,
                },
            });
        } else {
            post(
                { protocol: PROTOCOL, kind: "chunk_result", id, payload: { meshData, stats } },
                [meshData.positions.buffer, meshData.normals.buffer, meshData.uvs.buffer, meshData.indices.buffer]
            );
        }
    } catch (e: any) {
        post({
            protocol: PROTOCOL,
            kind: "error",
            id,
            payload: { code: "exception", message: String(e?.message ?? e) },
        });
    } finally {
        currentJobId = null;
        cancelCurrent = false;
    }
};
