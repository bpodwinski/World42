param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Section {
    param([string]$Title)
    Write-Output ""
    Write-Output "== $Title =="
}

function Scan {
    param(
        [string]$RelativePath,
        [string[]]$Patterns
    )

    $fullPath = Join-Path $RepoRoot $RelativePath
    Write-Output ""
    Write-Output "-- $RelativePath"

    if (-not (Test-Path $fullPath)) {
        Write-Output "  missing"
        return
    }

    $matches = Select-String -Path $fullPath -Pattern $Patterns -CaseSensitive:$false
    if (-not $matches) {
        Write-Output "  no matches"
        return
    }

    foreach ($m in $matches) {
        Write-Output ("  {0}:{1} {2}" -f $RelativePath, $m.LineNumber, $m.Line.Trim())
    }
}

Write-Output "World42 WASM worker-kernel contract audit"
Write-Output ("Repo: {0}" -f $RepoRoot)

Section "Protocol and message schema"
Scan -RelativePath "src/systems/lod/workers/worker_protocol.ts" -Patterns @(
    "MESH_KERNEL_PROTOCOL",
    "kind:",
    "meshFormat",
    "ChunkBoundsInfo",
    "isMeshKernelMessage",
    "cancel"
)

Section "Worker runtime behavior"
Scan -RelativePath "src/systems/lod/workers/terrain_mesh_worker.ts" -Patterns @(
    "build_chunk",
    "meshFormat",
    "isChunkMeshData",
    "isTypedMeshData",
    "cancelCurrent",
    'post\(',
    "payload:"
)

Section "Caller defaults and payload construction"
Scan -RelativePath "src/systems/lod/chunks/chunk_forge.ts" -Patterns @(
    'kind: "build_chunk"',
    "meshFormat",
    "noise:",
    "globalTerrainAmplitude",
    "octaves",
    "baseFrequency"
)

Section "Pool level error mapping"
Scan -RelativePath "src/systems/lod/workers/worker_pool.ts" -Patterns @(
    "protocol_error",
    "worker_error",
    "chunk_result",
    "ready",
    "onError"
)

Section "Rust export and output keys"
Scan -RelativePath "terrain/src/lib.rs" -Patterns @(
    "#\\[wasm_bindgen\\]",
    "pub fn build_chunk",
    '"positions"',
    '"normals"',
    '"uvs"',
    '"indices"',
    '"boundsInfo"',
    '"centerLocal"',
    '"boundingRadius"'
)

Section "Existing tests"
Scan -RelativePath "src/systems/lod/workers/worker_protocol.test.ts" -Patterns @(
    "MESH_KERNEL_PROTOCOL",
    "isMeshKernelMessage",
    "build_chunk",
    "meshFormat"
)

Write-Output ""
Write-Output "Audit complete."
