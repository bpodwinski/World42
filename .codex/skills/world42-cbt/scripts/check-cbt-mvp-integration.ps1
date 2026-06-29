param(
    [string]$RepoRoot = "."
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command rg -ErrorAction SilentlyContinue)) {
    throw "ripgrep (rg) is required for this script."
}

Push-Location $RepoRoot
try {
    Write-Host "== LOD routing touch points =="
    rg -n "setupLodAndShadows|createCDLODForSystem|LodScheduler|lodAlgorithm|cbt" src/app src/game_world src/systems/lod

    Write-Host ""
    Write-Host "== Camera and coordinate-space contracts =="
    rg -n "doublepos|toRenderSpace\(|toWorldSpace\(|distanceToSim\(|WorldDouble|Render-space|planet-local" src/core src/systems/lod src/game_world

    Write-Host ""
    Write-Host "== Existing terrain render/shader path =="
    rg -n "TerrainShader|terrainFragmentShader|terrainVertexShader|ChunkForge|receiveShadows" src/game_objects src/assets/shaders src/systems/lod
}
finally {
    Pop-Location
}
