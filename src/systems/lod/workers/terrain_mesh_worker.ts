/// <reference lib="webworker" />

import type {
    ChunkMeshData,
    ChunkMeshDataTyped,
    MeshKernelBuildChunkRequest,
    MeshKernelBuildTriangleChunkRequest,
    MeshKernelRequest,
    MeshKernelResponse,
} from './worker_protocol';
import {
    MESH_KERNEL_PROTOCOL,
    isMeshKernelMessage,
} from './worker_protocol';
import initWasm, {
    build_chunk,
    build_triangle_chunk,
    type InitInput,
} from '../../../../terrain/pkg/terrain_generator.js';

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
const PROTOCOL = MESH_KERNEL_PROTOCOL;

let wasmReady: Promise<void> | null = null;
let currentJobId: string | null = null;
let cancelCurrent = false;

function ensureWasmReady(): Promise<void> {
    if (!wasmReady) {
        const wasmUrl = new URL('../../../../terrain/pkg/terrain_generator_bg.wasm', import.meta.url);
        wasmReady = initWasm(wasmUrl as InitInput).then(() => undefined);
    }
    return wasmReady;
}

function post(msg: MeshKernelResponse, transfer?: Transferable[]): void {
    workerScope.postMessage(msg, transfer ?? []);
}

function isArrayLikeNumber(value: unknown): value is ArrayLike<number> {
    if (Array.isArray(value)) return true;
    return (
        value instanceof Float32Array ||
        value instanceof Uint16Array ||
        value instanceof Uint32Array
    );
}

function isChunkMeshData(value: unknown): value is ChunkMeshData {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ChunkMeshData>;
    return (
        isArrayLikeNumber(candidate.positions) &&
        isArrayLikeNumber(candidate.normals) &&
        isArrayLikeNumber(candidate.morphDeltas) &&
        isArrayLikeNumber(candidate.uvs) &&
        isArrayLikeNumber(candidate.indices)
    );
}

function isTypedMeshData(value: ChunkMeshData): value is ChunkMeshDataTyped {
    return (
        value.positions instanceof Float32Array &&
        value.normals instanceof Float32Array &&
        value.morphDeltas instanceof Float32Array &&
        value.uvs instanceof Float32Array &&
        (value.indices instanceof Uint16Array || value.indices instanceof Uint32Array)
    );
}

workerScope.onmessage = async (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isMeshKernelMessage(message)) return;

    if (
        message.kind === 'ready' ||
        message.kind === 'chunk_result' ||
        message.kind === 'error'
    ) {
        return;
    }

    const msg: MeshKernelRequest = message;
    if (msg.kind === 'init') {
        try {
            await ensureWasmReady();
            post({
                protocol: PROTOCOL,
                kind: 'ready',
                id: msg.id,
                payload: { impl: 'wasm', meshFormats: ['typed', 'arrays'] },
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            post({
                protocol: PROTOCOL,
                kind: 'error',
                id: msg.id,
                payload: { code: 'wasm_init_failed', message },
            });
        }
        return;
    }

    if (msg.kind === 'cancel') {
        const cancelId = msg.payload?.cancelId;
        if (cancelId && currentJobId === cancelId) cancelCurrent = true;
        return;
    }

    const id = msg.id;
    const startedAt = performance.now();

    try {
        await ensureWasmReady();

        currentJobId = id;
        cancelCurrent = false;

        let meshDataRaw: unknown;
        let meshFormat: 'arrays' | 'typed' = 'typed';

        if (msg.kind === 'build_chunk') {
            const payload = (msg as MeshKernelBuildChunkRequest).payload;
            meshFormat = payload.meshFormat ?? 'typed';
            meshDataRaw = build_chunk(
                payload.bounds.uMin,
                payload.bounds.uMax,
                payload.bounds.vMin,
                payload.bounds.vMax,
                payload.resolution,
                payload.radius,
                payload.face,
                payload.noise.seed ?? 1,
                payload.noise.octaves ?? 8,
                payload.noise.baseFrequency ?? 0,
                payload.noise.baseAmplitude ?? 0,
                payload.noise.lacunarity ?? 0,
                payload.noise.persistence ?? 0,
                payload.noise.globalTerrainAmplitude ?? 10
            );
        } else {
            const payload = (msg as MeshKernelBuildTriangleChunkRequest).payload;
            meshFormat = payload.meshFormat ?? 'typed';
            meshDataRaw = build_triangle_chunk(
                payload.v0[0], payload.v0[1], payload.v0[2],
                payload.v1[0], payload.v1[1], payload.v1[2],
                payload.v2[0], payload.v2[1], payload.v2[2],
                payload.resolution,
                payload.radius,
                payload.noise.seed ?? 1,
                payload.noise.octaves ?? 8,
                payload.noise.baseFrequency ?? 0,
                payload.noise.baseAmplitude ?? 0,
                payload.noise.lacunarity ?? 0,
                payload.noise.persistence ?? 0,
                payload.noise.globalTerrainAmplitude ?? 10
            );
        }

        if (!isChunkMeshData(meshDataRaw)) {
            throw new Error('Invalid mesh payload produced by WASM.');
        }

        if (cancelCurrent) {
            post({
                protocol: PROTOCOL,
                kind: 'error',
                id,
                payload: { code: 'cancelled', message: 'Job cancelled' },
            });
            return;
        }

        const meshData = meshDataRaw;
        const stats = {
            ms: performance.now() - startedAt,
            vertexCount: (meshData.positions.length / 3) | 0,
            indexCount: meshData.indices.length | 0,
        };

        // meshFormat already set above
        if (meshFormat === 'arrays') {
            post({
                protocol: PROTOCOL,
                kind: 'chunk_result',
                id,
                payload: {
                    meshData: {
                        ...meshData,
                        positions: Array.from(meshData.positions),
                        normals: Array.from(meshData.normals),
                        morphDeltas: Array.from(meshData.morphDeltas),
                        uvs: Array.from(meshData.uvs),
                        indices: Array.from(meshData.indices),
                    },
                    stats,
                },
            });
            return;
        }

        if (!isTypedMeshData(meshData)) {
            throw new Error('Typed mesh format requested but worker returned arrays.');
        }

        post(
            {
                protocol: PROTOCOL,
                kind: 'chunk_result',
                id,
                payload: { meshData, stats },
            },
            [
                meshData.positions.buffer,
                meshData.normals.buffer,
                meshData.morphDeltas.buffer,
                meshData.uvs.buffer,
                meshData.indices.buffer,
            ]
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        post({
            protocol: PROTOCOL,
            kind: 'error',
            id,
            payload: { code: 'exception', message },
        });
    } finally {
        currentJobId = null;
        cancelCurrent = false;
    }
};
