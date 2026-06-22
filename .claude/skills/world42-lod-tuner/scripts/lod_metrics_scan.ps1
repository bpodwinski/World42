param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Section {
    param([string]$Title)
    Write-Output ""
    Write-Output "== $Title =="
}

function Scan-File {
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
        $line = $m.Line.Trim()
        Write-Output ("  {0}:{1} {2}" -f $RelativePath, $m.LineNumber, $line)
    }
}

if (-not (Test-Path $RepoRoot)) {
    throw "Repo root does not exist: $RepoRoot"
}

Write-Output ("World42 LOD metrics scan")
Write-Output ("Repo: {0}" -f $RepoRoot)

Write-Section "Scheduler"
Scan-File -RelativePath "src/systems/lod/lod_scheduler.ts" -Patterns @(
    "maxConcurrent",
    "maxStartsPerFrame",
    "rescoreMs",
    "budgetMs"
)
Scan-File -RelativePath "src/app/setup_lod_and_shadows.ts" -Patterns @(
    "new LodScheduler",
    "maxConcurrent",
    "maxStartsPerFrame",
    "rescoreMs",
    "budgetMs"
)

Write-Section "Chunk thresholds and culling"
Scan-File -RelativePath "src/systems/lod/chunks/chunk_tree.ts" -Patterns @(
    "sseSplitThresholdPx",
    "sseMergeThresholdPx",
    "frustumPrefetchScale",
    "horizonPrefetchScale",
    "cullReliefMargin",
    "updateLOD"
)

Write-Section "Worker and mesh params"
Scan-File -RelativePath "src/systems/lod/workers/global_worker_pool.ts" -Patterns @(
    "hardwareConcurrency",
    "new WorkerPool",
    "mesh-worker",
    "terrain_mesh_worker"
)
Scan-File -RelativePath "src/systems/lod/chunks/chunk_forge.ts" -Patterns @(
    "octaves",
    "baseFrequency",
    "baseAmplitude",
    "lacunarity",
    "persistence",
    "globalTerrainAmplitude",
    "meshFormat"
)

Write-Section "Protocol"
Scan-File -RelativePath "src/systems/lod/workers/worker_protocol.ts" -Patterns @(
    "MESH_KERNEL_PROTOCOL",
    "meshFormat",
    "cancel"
)

Write-Output ""
Write-Output "Scan complete."
