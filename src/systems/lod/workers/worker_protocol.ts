export const MESH_KERNEL_PROTOCOL = 'mesh-kernel/1' as const;

export type MeshKernelFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export type MeshKernelBounds = {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
};

export type MeshKernelNoiseParams = {
    seed: number;
    octaves?: number;
    baseFrequency?: number;
    baseAmplitude?: number;
    lacunarity?: number;
    persistence?: number;
    globalTerrainAmplitude?: number;
};

export type MeshKernelBuildParams = {
    bounds: MeshKernelBounds;
    resolution: number;
    radius: number;
    face: MeshKernelFace;
    level: number;
    maxLevel: number;
    noise: MeshKernelNoiseParams;
    meshFormat?: 'arrays' | 'typed';
};

export type ChunkBoundsInfo = {
    centerLocal: [number, number, number];
    boundingRadius: number;
    minPlanetRadius: number;
    maxPlanetRadius: number;
};

export type ChunkMeshDataArrays = {
    positions: number[];
    normals: number[];
    morphDeltas: number[];
    uvs: number[];
    indices: number[];
    boundsInfo?: ChunkBoundsInfo;
};

export type ChunkMeshDataTyped = {
    positions: Float32Array;
    normals: Float32Array;
    morphDeltas: Float32Array;
    uvs: Float32Array;
    indices: Uint16Array | Uint32Array;
    boundsInfo?: ChunkBoundsInfo;
};

export type ChunkMeshData = ChunkMeshDataArrays | ChunkMeshDataTyped;

export type MeshKernelChunkStats = {
    ms?: number;
    vertexCount?: number;
    indexCount?: number;
};

export type MeshKernelInitRequest = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: 'init';
    id: string;
    payload?: Record<string, never>;
};

export type MeshKernelBuildChunkRequest = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: 'build_chunk';
    id: string;
    payload: MeshKernelBuildParams;
};

export type MeshKernelTriangleBuildParams = {
    v0: [number, number, number];
    v1: [number, number, number];
    v2: [number, number, number];
    resolution: number;
    radius: number;
    level: number;
    maxLevel: number;
    noise: MeshKernelNoiseParams;
    meshFormat?: 'arrays' | 'typed';
};

export type MeshKernelBuildTriangleChunkRequest = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: 'build_triangle_chunk';
    id: string;
    payload: MeshKernelTriangleBuildParams;
};

export type MeshKernelCancelRequest = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: 'cancel';
    id: string;
    payload: { cancelId: string };
};

export type MeshKernelRequest =
    | MeshKernelInitRequest
    | MeshKernelBuildChunkRequest
    | MeshKernelBuildTriangleChunkRequest
    | MeshKernelCancelRequest;

export type MeshKernelReady = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: 'ready';
    id: string;
    payload: {
        impl: 'js' | 'wasm';
        meshFormats: Array<'arrays' | 'typed'>;
    };
};

export type MeshKernelChunkResult = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: 'chunk_result';
    id: string;
    payload: {
        meshData: ChunkMeshData;
        stats?: MeshKernelChunkStats;
    };
};

export type MeshKernelErrorPayload = {
    code: string;
    message: string;
};

export type MeshKernelError = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: 'error';
    id: string;
    payload: MeshKernelErrorPayload;
};

export type MeshKernelResponse = MeshKernelReady | MeshKernelChunkResult | MeshKernelError;

export type MeshKernelMessage = MeshKernelRequest | MeshKernelResponse;

export function isMeshKernelMessage(message: unknown): message is MeshKernelMessage {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as Partial<MeshKernelMessage>;
    return candidate.protocol === MESH_KERNEL_PROTOCOL && typeof candidate.kind === 'string';
}
