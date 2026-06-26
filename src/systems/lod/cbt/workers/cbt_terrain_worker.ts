/// <reference lib="webworker" />
/**
 * Off-thread CBT terrain worker (`cbt-kernel/1`). Owns one Rust/WASM `CbtKernel`
 * per planet; runs classify + split/merge + emit and returns emitted geometry to
 * the main thread via transferables. Stateful: trees live here, only camera params come in.
 */
import initWasm, {
    CbtKernel,
    type InitInput,
} from '../../../../../terrain/pkg/terrain_generator.js';
import {
    CBT_KERNEL_PROTOCOL,
    cbtGeometryTransferables,
    isCbtMessage,
    type CbtGeometry,
    type CbtGeometryStats,
    type CbtResponse,
} from './cbt_worker_protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const kernels = new Map<string, CbtKernel>();
let wasmReady: Promise<void> | null = null;

function ensureWasmReady(): Promise<void> {
    if (!wasmReady) {
        const wasmUrl = new URL(
            '../../../../../terrain/pkg/terrain_generator_bg.wasm',
            import.meta.url
        );
        wasmReady = initWasm(wasmUrl as InitInput).then(() => undefined);
    }
    return wasmReady;
}

function post(message: CbtResponse, transfer?: Transferable[]): void {
    scope.postMessage(message, transfer ?? []);
}

/** Raw shape returned by CbtKernel.update (a plain JS object built in Rust). */
type KernelResult = {
    geometryChanged: boolean;
    leafCount: number;
    splitsThisFrame: number;
    mergesThisFrame: number;
    lastVertexCount: number;
    geometry?: CbtGeometry;
};

function sendResult(
    key: string,
    gen: number,
    result: KernelResult,
    computeMs: number
): void {
    const stats: CbtGeometryStats = {
        leafCount: result.leafCount,
        splitsThisFrame: result.splitsThisFrame,
        mergesThisFrame: result.mergesThisFrame,
        classifyMs: computeMs,
        emitMs: 0,
        lastVertexCount: result.lastVertexCount,
    };
    if (result.geometryChanged && result.geometry) {
        const geometry = result.geometry;
        post(
            {
                protocol: CBT_KERNEL_PROTOCOL,
                kind: 'geometry_result',
                id: '',
                payload: { key, gen, geometryChanged: true, geometry, stats },
            },
            cbtGeometryTransferables(geometry)
        );
    } else {
        post({
            protocol: CBT_KERNEL_PROTOCOL,
            kind: 'geometry_result',
            id: '',
            payload: { key, gen, geometryChanged: false, stats },
        });
    }
}

scope.onmessage = async (event: MessageEvent): Promise<void> => {
    const msg = event.data;
    if (!isCbtMessage(msg) || !('kind' in msg)) return;

    try {
        switch (msg.kind) {
            case 'init': {
                await ensureWasmReady();
                post({
                    protocol: CBT_KERNEL_PROTOCOL,
                    kind: 'ready',
                    id: msg.id,
                    payload: { impl: 'wasm' },
                });
                break;
            }
            case 'create_planet': {
                await ensureWasmReady();
                const p = msg.payload;
                const kernel = new CbtKernel(
                    p.radiusSim,
                    p.maxDepth,
                    p.splitThresholdPx2,
                    p.splitHysteresis,
                    p.maxSplitsPerFrame,
                    p.maxMergesPerFrame,
                    p.cullBackface,
                    p.cullMinDot,
                    p.frustumGuardScale,
                    p.noise.seed,
                    p.noise.octaves,
                    p.noise.baseFrequency,
                    p.noise.baseAmplitude,
                    p.noise.lacunarity,
                    p.noise.persistence,
                    p.noise.globalAmplitude
                );
                kernels.set(p.key, kernel);
                if (p.prewarm) {
                    const hasFrustum = p.prewarm.hasFrustum === 1;
                    kernel.prewarm(p.prewarm.params, hasFrustum, p.prewarm.maxIters);
                    const t0 = performance.now();
                    const result = kernel.update(
                        p.prewarm.params,
                        hasFrustum
                    ) as KernelResult;
                    sendResult(p.key, 0, result, performance.now() - t0);
                }
                break;
            }
            case 'update_planet': {
                const kernel = kernels.get(msg.payload.key);
                if (!kernel) break;
                const hasFrustum = msg.payload.hasFrustum === 1;
                const t0 = performance.now();
                const result = kernel.update(
                    msg.payload.params,
                    hasFrustum
                ) as KernelResult;
                sendResult(msg.payload.key, msg.payload.gen, result, performance.now() - t0);
                break;
            }
            case 'reset_planet': {
                kernels.get(msg.payload.key)?.reset_now();
                break;
            }
            case 'dispose_planet': {
                const kernel = kernels.get(msg.payload.key);
                kernels.delete(msg.payload.key);
                kernel?.free();
                break;
            }
            default:
                break;
        }
    } catch (err) {
        post({
            protocol: CBT_KERNEL_PROTOCOL,
            kind: 'error',
            id: 'kind' in msg ? msg.id : '',
            payload: {
                code: 'exception',
                message: err instanceof Error ? err.message : String(err),
            },
        });
    }
};
