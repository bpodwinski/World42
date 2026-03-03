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

function Scan-Path {
    param(
        [string]$Path,
        [string[]]$Patterns
    )

    $fullPath = Join-Path $RepoRoot $Path
    Write-Output ""
    Write-Output "-- $Path"

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
        Write-Output ("  {0}:{1} {2}" -f $Path, $m.LineNumber, $m.Line.Trim())
    }
}

function Scan-Glob {
    param(
        [string]$GlobPath,
        [string[]]$Patterns
    )

    $fullGlob = Join-Path $RepoRoot $GlobPath
    Write-Output ""
    Write-Output "-- $GlobPath"

    $matches = Select-String -Path $fullGlob -Pattern $Patterns -CaseSensitive:$false
    if (-not $matches) {
        Write-Output "  no matches"
        return
    }

    foreach ($m in $matches) {
        $relative = $m.Path.Replace($RepoRoot + "\", "").Replace("\", "/")
        Write-Output ("  {0}:{1} {2}" -f $relative, $m.LineNumber, $m.Line.Trim())
    }
}

Write-Output "World42 coordinate-space usage scan"
Write-Output ("Repo: {0}" -f $RepoRoot)

Write-Section "Canonical conversion APIs"
Scan-Path -Path "src/core/camera/camera_manager.ts" -Patterns @(
    "toRenderSpace",
    "toWorldSpace",
    "doublepos",
    "camera\.position"
)
Scan-Path -Path "src/systems/lod/chunks/chunk_geometry.ts" -Patterns @(
    "localToWorldDouble",
    "TransformNormalToRef"
)

Write-Section "Unit conversions"
Scan-Path -Path "src/core/scale/scale_manager.ts" -Patterns @(
    "toSimulationUnits",
    "toRealUnits",
    "toSimulationVector",
    "toRealVector"
)
Scan-Path -Path "src/game_world/stellar_system/stellar_catalog_loader.ts" -Patterns @(
    "position_km",
    "ScaleManager\.toSimulationUnits",
    "ScaleManager\.toSimulationVector",
    "positionWorldDouble",
    "doublepos"
)

Write-Section "Potential mixed-space hotspots"
Scan-Path -Path "src/systems/lod/chunks/chunk_tree.ts" -Patterns @(
    "camera\.doublepos",
    "camera\.position",
    "centerWorld",
    "centerRender",
    "planetCenter",
    "local"
)
Scan-Path -Path "src/systems/lod/chunks/chunk_culling_eval.ts" -Patterns @(
    "centerWorldDouble",
    "centerRender",
    "subtractToRef",
    "frustum"
)
Scan-Glob -GlobPath "src/**/*.ts" -Patterns @(
    "camera\.position",
    "camera\.doublepos",
    "toRenderSpace\(",
    "toWorldSpace\(",
    "localToWorldDouble\("
)

Write-Output ""
Write-Output "Scan complete."
