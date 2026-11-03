$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
& $config.runtime.python -B (Join-Path $PSScriptRoot 'check-runtime.py')
if ($LASTEXITCODE -ne 0) { throw 'Bundled runtime verification failed. See the component error above for details.' }
$node = 'node'
$distributionFile = Join-Path $root 'config\distribution.json'
if (Test-Path -LiteralPath $distributionFile) {
    $distribution = Get-Content -LiteralPath $distributionFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($distribution.node) { $node = $distribution.node }
}
& $node --version
if ($LASTEXITCODE -ne 0) { throw 'Node runtime verification failed.' }
