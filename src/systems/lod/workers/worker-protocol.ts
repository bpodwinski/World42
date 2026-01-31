export const MESH_KERNEL_PROTOCOL = "mesh-kernel/1" as const;

export type MeshKernelFace = "front" | "back" | "left" | "right" | "top" | "bottom";

export type MeshKernelBounds = {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
};

export type MeshKernelNoiseParams = {
    seed: number;
    // (optionnel) pour figer le contrat dès maintenant
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
    /**
     * "arrays" = number[] (compat max)
     * "typed"  = Float32Array/Uint32Array (perf + WASM-friendly)
     */
    meshFormat?: "arrays" | "typed";
};

export type ChunkBoundsInfo = {
    // Planet-local (origine planète)
    centerLocal: [number, number, number];
    boundingRadius: number;
    minPlanetRadius: number;
    maxPlanetRadius: number;
};

export type ChunkMeshDataArrays = {
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
    boundsInfo?: ChunkBoundsInfo;
};

export type ChunkMeshDataTyped = {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    boundsInfo?: ChunkBoundsInfo;
};

export type ChunkMeshData = ChunkMeshDataArrays | ChunkMeshDataTyped;

export type MeshKernelInitRequest = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: "init";
    id: string;
    payload?: {
        // futur: wasmUrl, features, etc.
    };
};

export type MeshKernelBuildChunkRequest = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: "build_chunk";
    id: string;
    payload: MeshKernelBuildParams;
};

export type MeshKernelCancelRequest = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: "cancel";
    id: string;
    payload: { cancelId: string };
};

export type MeshKernelRequest =
    | MeshKernelInitRequest
    | MeshKernelBuildChunkRequest
    | MeshKernelCancelRequest;

export type MeshKernelReady = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: "ready";
    id: string;
    payload: {
        impl: "js" | "wasm";
        meshFormats: Array<"arrays" | "typed">;
    };
};

export type MeshKernelChunkResult = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: "chunk_result";
    id: string; // job id
    payload: {
        meshData: ChunkMeshData;
        stats?: { ms?: number; vertexCount?: number; indexCount?: number };
    };
};

export type MeshKernelError = {
    protocol: typeof MESH_KERNEL_PROTOCOL;
    kind: "error";
    id: string; // job id (ou init id)
    payload: { code: string; message: string };
};

export type MeshKernelResponse = MeshKernelReady | MeshKernelChunkResult | MeshKernelError;
