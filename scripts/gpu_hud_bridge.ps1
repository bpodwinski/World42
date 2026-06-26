# GPU HUD bridge — feeds public/gpu_stats.json with live NVIDIA GPU stats so the
# in-app perf HUD can show OS-level GPU utilization / VRAM (the browser itself cannot
# read these). Run this ALONGSIDE `npm run serve`, in its own terminal:
#
#   powershell -ExecutionPolicy Bypass -File scripts/gpu_hud_bridge.ps1
#
# The HUD (press P) polls /gpu_stats.json once a second and shows the values while this
# is running; when it is not running the HUD just shows "GPU% n/a" (the file goes stale).
# Dev-only + whole-GPU (not per-tab). Requires nvidia-smi on PATH (NVIDIA driver).

$ErrorActionPreference = 'SilentlyContinue'
$out = Join-Path $PSScriptRoot '..\public\gpu_stats.json'
$intervalMs = 500
Write-Host "GPU HUD bridge -> $out  (every ${intervalMs}ms, Ctrl+C to stop)"

while ($true) {
    $csv = & nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,clocks.sm,power.draw --format=csv,noheader,nounits
    if ($csv) {
        $p = ($csv -split ',') | ForEach-Object { $_.Trim() }
        # Guard: only emit when the utilization field is numeric (skips [N/A] rows).
        if ($p.Count -ge 5 -and $p[0] -match '^\d+(\.\d+)?$') {
            $json = '{"util":' + $p[0] + ',"vramUsed":' + $p[1] + ',"vramTotal":' + $p[2] +
                    ',"clock":' + $p[3] + ',"power":' + $p[4] + '}'
            [System.IO.File]::WriteAllText($out, $json)
        }
    }
    Start-Sleep -Milliseconds $intervalMs
}
