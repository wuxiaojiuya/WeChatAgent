param([string]$PythonPath = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Project config preparation failed.' }
$config = Get-Content (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $PythonPath) { $PythonPath = $config.runtime.python }
$python = (Get-Command $PythonPath -ErrorAction Stop).Source
function Install-Npm([string]$Directory,[bool]$Legacy) {
    Push-Location $Directory
    try {
        $arguments = @('ci','--ignore-scripts','--no-audit','--no-fund','--prefer-offline')
        if ($Legacy) { $arguments += '--legacy-peer-deps' }
        & npm.cmd @arguments
        if ($LASTEXITCODE -ne 0) { throw ('npm ci failed in '+$Directory) }
    } finally { Pop-Location }
}
Install-Npm (Join-Path $root 'packages\dsh-social-bridge-plugin') $false
& $python -m pip install --only-binary=:all: -r (Join-Path $PSScriptRoot 'hook-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Hook receiver dependency installation failed.' }
& $python -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Python dependency conflicts detected.' }
Write-Output ('Install the local plugin in DSH Desktop: '+(Join-Path $root 'packages\dsh-social-bridge-plugin'))
Write-Output 'Dependencies installed. Select WeChat 4.1.8.27 in Settings, open it with the bundled Hook, log in, then start the assistant from Overview.'
