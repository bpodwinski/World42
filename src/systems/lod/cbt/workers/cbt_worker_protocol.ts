/**
 * `cbt-kernel/1` — message protocol for the off-thread CBT terrain worker.
 *
 * STATEFUL protocol: the worker owns each planet's CBT tree (typed-array pool + emit
 * cache). The main thread sends only camera parameters per frame (tiny) and
 * receives emitted geometry back via transferables (the only large payload).
 *
 * No SharedArrayBuffer is used anywhere — GitHub Pages cannot set COOP/COEP, so
 * `crossOriginIsolated` is false in production. The worker-owns-the-tree design
 * is what makes plain transferables sufficient.
 */
export const CBT_KERNEL_PROTOCOL = 'cbt-kernel/1' as const;

/** Noise field params — mirrors {@link NoiseParams} in cbt_noise.ts. */
export type CbtNoiseParams = {
    seed: number;
    octaves: number;
    baseFrequency: number;
    baseAmplitude: number;
    lacunarity: number;
    persistence: number;
    globalAmplitude: number;
};

/**
 * Per-frame camera parameters packed as a flat Float64Array (so WorldDouble
 * survives structured clone at full f64 precision). Layout:
 *   [0..2]   cameraWorldDouble (x,y,z)
 *   [3..5]   planetCenterWorldDouble (x,y,z)
 *   [6..21]  renderParentWorldMatrix (16, row-major Babylon Matrix.m)
 *   [22]     viewportHeightPx
 *   [23]     cameraFovRadians
 *   [24..47] frustumPlanes: 6 * (nx,ny,nz,d)   — present only when hasFrustum=1
 */
export const CBT_PARAMS_BASE_LEN = 24;
export const CBT_PARAMS_WITH_FRUSTUM_LEN = 48;

// ---- requests (main -> worker) --------------------------------------------

export type CbtInitRequest = {
    protocol: typeof CBT_KERNEL_PROTOCOL;
    kind: 'init';
    id: string;
};

export type CbtCreatePlanetRequest = {
    protocol: typeof CBT_KERNEL_PROTOCOL;
    kind: 'create_planet';
    id: string;
    payload: {
        key: string;
        radiusSim: number;
        maxDepth: number;
        splitThresholdPx2: number;
        splitHysteresis: number;
        maxSplitsPerFrame: number;
        maxMergesPerFrame: number;
        cullBackface: boolean;
        cullMinDot: number;
        frustumGuardScale: number;
        incrementalMesh: boolean;
        noise: CbtNoiseParams;
        /** Optional worker-side prewarm before the first geometry_result. */
        prewarm?: {
            params: Float64Array;
            hasFrustum: 0 | 1;
            maxIters: number;
        };
    };
};

export type CbtUpdatePlanetRequest = {
    protocol: typeof CBT_KERNEL_PROTOCOL;
    kind: 'update_planet';
    id: string;
    payload: {
        key: string;
        /** Monotonic per-planet generation; echoed back in geometry_result. */
        gen: number;
        hasFrustum: 0 | 1;
        /** Flat camera params (see CBT_PARAMS_* layout). Copied, not transferred. */
        params: Float64Array;
    };
};

export type CbtResetPlanetRequest = {
    protocol: typeof CBT_KERNEL_PROTOCOL;
    kind: 'reset_planet';
    id: string;
    payload: { key: string };
};

export type CbtDisposePlanetRequest = {
    protocol: typeof CBT_KERNEL_PROTOCOL;
    kind: 'dispose_planet';
    id: string;
    payload: { key: string };
};

export type CbtRequest =
    | CbtInitRequest
    | CbtCreatePlanetRequest
    | CbtUpdatePlanetRequest
    | CbtResetPlanetRequest
    | CbtDisposePlanetRequest;

// ---- responses (worker -> main) -------------------------------------------

export type CbtReady = {
    protocol: typeof CBT_KERNEL_PROTOCOL;
    kind: 'ready';
    id: string;
    payload: { impl: 'wasm' };
};

/** Emitted mesh — same shape as cbt_emit.ts EmitResult; all buffers transferred. */
export type CbtGeometry = {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;
    morphDeltas: Float32Array;
    indices: Uint16Array | Uint32Array;
};

export type CbtGeometryStats = {
    leafCount: number;
    splitsThisFrame: number;
    mergesThisFrame: number;
    classifyMs: number;
    emitMs: number;
    lastVertexCount: number;
};

export type CbtGeometryResult = {
    protocol: typeof CBT_KERNEL_PROTOCOL;
    kind: 'geometry_result';
    id: string;
    payload: {
        key: string;
        gen: number;
        /** False when the tree did not change — `geometry` is then omitted. */
        geometryChanged: boolean;
        geometry?: CbtGeometry;
        stats: CbtGeometryStats;
    };
};

export type CbtErrorPayload = {
    code: string;
    message: string;
    key?: string;
};

export type CbtError = {
    protocol: typeof CBT_KERNEL_PROTOCOL;
    kind: 'error';
    id: string;
    payload: CbtErrorPayload;
};

export type CbtResponse = CbtReady | CbtGeometryResult | CbtError;

export type CbtMessage = CbtRequest | CbtResponse;

export function isCbtMessage(message: unknown): message is CbtMessage {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as Partial<CbtMessage>;
    return (
        candidate.protocol === CBT_KERNEL_PROTOCOL &&
        typeof candidate.kind === 'string'
    );
}

/** Transferable buffers for a {@link CbtGeometry} payload (zero-copy to main). */
export function cbtGeometryTransferables(geometry: CbtGeometry): Transferable[] {
    return [
        geometry.positions.buffer,
        geometry.normals.buffer,
        geometry.uvs.buffer,
        geometry.colors.buffer,
        geometry.morphDeltas.buffer,
        geometry.indices.buffer,
    ];
}
