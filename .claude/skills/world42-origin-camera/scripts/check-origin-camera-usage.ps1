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
    Write-Host "== OriginCamera class and API usage =="
    rg -n "class\s+OriginCamera|doublepos|toRenderSpace\(|toWorldSpace\(|distanceToSim\(|speedSim|velocitySim|getFrustumPlanesToRef\(" src

    Write-Host ""
    Write-Host "== Potential mixed-space hotspots =="
    rg -n "camera\.position|camera\.doublepos|subtractToRef\(camWorldDouble|centerRender|WorldDouble|Render-space" src/core src/app src/systems/lod src/game_world

    Write-Host ""
    Write-Host "== Teleport and bootstrap hooks =="
    rg -n "teleportToEntity|new OriginCamera|setTarget\(|toRenderSpace\(" src/app src/core/camera
}
finally {
    Pop-Location
}
