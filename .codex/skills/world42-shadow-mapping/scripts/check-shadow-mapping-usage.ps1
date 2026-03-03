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
    Write-Host "== Shadow setup and context =="
    rg -n "setupLodAndShadows|TerrainShadowContext|setTerrainShadowContext|ShadowGenerator|blendStart|blendEnd|shadowMinZ|shadowMaxZ" src/app src/game_objects

    Write-Host ""
    Write-Host "== Terrain shader uniform contract =="
    rg -n "shadowSamplerNear|shadowSamplerFar|lightMatrixNear|lightMatrixFar|shadowBias|shadowNormalBias|shadowReverseDepth|shadowNdcHalfZRange|cameraPosRender" src/game_objects src/assets/shaders/terrain

    Write-Host ""
    Write-Host "== Shadow caster lifecycle =="
    rg -n "addShadowCaster|removeShadowCaster|receiveShadows" src/systems/lod/chunks src/game_objects
}
finally {
    Pop-Location
}
