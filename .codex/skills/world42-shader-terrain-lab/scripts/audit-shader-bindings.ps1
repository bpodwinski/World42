param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-Text {
    param([string]$RelativePath)
    $path = Join-Path $RepoRoot $RelativePath
    if (-not (Test-Path $path)) {
        throw "Missing file: $RelativePath"
    }
    return Get-Content $path -Raw
}

function Get-GlslUniforms {
    param([string]$Text)
    $m = [regex]::Matches($Text, '(?m)^\s*uniform\s+\w+\s+(\w+)\s*;')
    return $m | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
}

function Get-GlslSamplers {
    param([string]$Text)
    $m = [regex]::Matches($Text, '(?m)^\s*uniform\s+sampler\w*\s+(\w+)\s*;')
    return $m | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
}

function Get-QuotedListFromArray {
    param(
        [string]$Text,
        [string]$ArrayName
    )
    $rx = 'const\s+' + [regex]::Escape($ArrayName) + '\s*=\s*\[(?<body>[\s\S]*?)\]\s*;'
    $m = [regex]::Match($Text, $rx)
    if (-not $m.Success) { return @() }
    $body = $m.Groups['body'].Value
    $q = [regex]::Matches($body, "'([^']+)'")
    return $q | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
}

function Get-QuotedListFromPropertyArray {
    param(
        [string]$Text,
        [string]$PropertyName
    )
    $rx = [regex]::Escape($PropertyName) + '\s*:\s*\[(?<body>[\s\S]*?)\]\s*,'
    $m = [regex]::Match($Text, $rx)
    if (-not $m.Success) { return @() }
    $body = $m.Groups['body'].Value
    $q = [regex]::Matches($body, "'([^']+)'")
    return $q | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
}

function Get-SetCalls {
    param([string]$Text)
    $m = [regex]::Matches($Text, "set[A-Za-z0-9]+\(\s*'([^']+)'")
    return $m | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
}

function Print-Diff {
    param(
        [string]$Title,
        [string[]]$Expected,
        [string[]]$Actual
    )
    Write-Output ""
    Write-Output "== $Title =="

    $missing = $Expected | Where-Object { $_ -notin $Actual }
    $extra = $Actual | Where-Object { $_ -notin $Expected }

    if (-not $missing -and -not $extra) {
        Write-Output "  OK"
        return
    }

    if ($missing) {
        Write-Output "  Missing:"
        $missing | ForEach-Object { Write-Output "    $_" }
    }
    if ($extra) {
        Write-Output "  Extra:"
        $extra | ForEach-Object { Write-Output "    $_" }
    }
}

Write-Output "World42 shader binding audit"
Write-Output ("Repo: {0}" -f $RepoRoot)

# Terrain pipeline
$terrainVs = Read-Text "src/assets/shaders/terrain/terrainVertexShader.glsl"
$terrainFs = Read-Text "src/assets/shaders/terrain/terrainFragmentShader.glsl"
$terrainTs = Read-Text "src/game_objects/planets/rocky_planet/terrains_shader.ts"

$terrainGlslUniforms = (Get-GlslUniforms $terrainVs) + (Get-GlslUniforms $terrainFs) | Sort-Object -Unique
$terrainGlslSamplers = (Get-GlslSamplers $terrainVs) + (Get-GlslSamplers $terrainFs) | Sort-Object -Unique
$terrainGlslNonSamplerUniforms = $terrainGlslUniforms | Where-Object { $_ -notin $terrainGlslSamplers }
$terrainDeclaredUniforms = Get-QuotedListFromPropertyArray -Text $terrainTs -PropertyName "uniforms"
$terrainDeclaredSamplers = Get-QuotedListFromPropertyArray -Text $terrainTs -PropertyName "samplers"
$terrainSetCalls = Get-SetCalls $terrainTs
$terrainSetCallsUniformOnly = $terrainSetCalls | Where-Object { $_ -notin $terrainDeclaredSamplers }
$terrainAutoBoundUniforms = @("world", "worldViewProjection")
$terrainDeclaredUniformsNeedingSet = $terrainDeclaredUniforms | Where-Object { $_ -notin $terrainAutoBoundUniforms }

Print-Diff -Title "Terrain GLSL uniforms vs TS declared uniforms" -Expected $terrainGlslNonSamplerUniforms -Actual $terrainDeclaredUniforms
Print-Diff -Title "Terrain declared uniforms vs set* calls" -Expected $terrainDeclaredUniformsNeedingSet -Actual $terrainSetCallsUniformOnly
Print-Diff -Title "Terrain GLSL samplers vs TS declared samplers" -Expected $terrainGlslSamplers -Actual $terrainDeclaredSamplers

# Atmosphere pipeline
$atmGlsl = Read-Text "src/assets/shaders/atmosphericScatteringFragmentShader.glsl"
$atmTs = Read-Text "src/game_objects/planets/rocky_planet/atmospheric-ccattering-postprocess.ts"

$atmGlslUniforms = Get-GlslUniforms $atmGlsl
$atmGlslSamplers = Get-GlslSamplers $atmGlsl
$atmGlslNonSamplerUniforms = $atmGlslUniforms | Where-Object { $_ -notin $atmGlslSamplers }
$atmDeclaredUniforms = Get-QuotedListFromArray -Text $atmTs -ArrayName "SHADER_UNIFORMS"
$atmDeclaredSamplers = Get-QuotedListFromArray -Text $atmTs -ArrayName "SHADER_SAMPLERS"
$atmSetCalls = Get-SetCalls $atmTs
$atmSetCallsUniformOnly = $atmSetCalls | Where-Object { $_ -notin $atmDeclaredSamplers }

Print-Diff -Title "Atmosphere GLSL uniforms vs SHADER_UNIFORMS" -Expected $atmGlslNonSamplerUniforms -Actual $atmDeclaredUniforms
Print-Diff -Title "Atmosphere declared uniforms vs set* calls" -Expected $atmDeclaredUniforms -Actual $atmSetCallsUniformOnly
Print-Diff -Title "Atmosphere GLSL samplers vs SHADER_SAMPLERS" -Expected $atmGlslSamplers -Actual $atmDeclaredSamplers

Write-Output ""
Write-Output "Audit complete."
