param([switch]$PrepareOnly,[switch]$UpdateHook)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Project configuration invalid.' }
& (Join-Path $PSScriptRoot 'launch-supplier-hook.ps1') -PrepareOnly:$PrepareOnly
exit $LASTEXITCODE