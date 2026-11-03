param([string]$FixtureRoot)
$ErrorActionPreference='Stop'
$env:APPDATA=Join-Path $FixtureRoot 'appdata'
$env:LOCALAPPDATA=Join-Path ([IO.Path]::GetTempPath()) ('supplier-ascii-'+[Guid]::NewGuid().ToString('N'))
$global:supplierFixtureLaunches=0
function Get-Item {
    param($LiteralPath)
    if($LiteralPath -ne (Join-Path $FixtureRoot 'client folder\Weixin.exe')){return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath}
    [pscustomobject]@{VersionInfo=[pscustomobject]@{FileVersion='4.1.8.27'}}
}
function Get-AuthenticodeSignature {
    param($LiteralPath)
    [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Subject='CN=Tencent fixture'}}
}
function Get-Process {
    param($Name,$Id,$ErrorAction)
    if($Id){[pscustomobject]@{Id=99;Path=(Join-Path $FixtureRoot 'client folder\Weixin.exe');Modules=@([pscustomobject]@{FileName=$global:supplierFixtureDll})}}
}
function Get-NetTCPConnection {
    param($LocalPort,$State,$ErrorAction)
    if($global:supplierFixtureLaunches -gt 0){[pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=99}}
}
function Start-Process {
    param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError)
    $manifest=Get-Content (Join-Path $FixtureRoot 'state\hook\supplier-4.1.8.27\manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($FilePath -ne (Join-Path $manifest.runtimeDirectory 'x64 inject.exe') -or $FilePath -match '[^\x00-\x7F]'){throw 'Wrong injector runtime'}
    $global:supplierFixtureDll=Join-Path $manifest.runtimeDirectory 'libGLESv1.dll'
    if($WorkingDirectory -ne (Join-Path $FixtureRoot 'client folder')){throw 'Wrong working directory'}
    $expected='"'+(Join-Path $FixtureRoot 'client folder\Weixin.exe')+'" "'
    if(-not $ArgumentList.StartsWith($expected)){throw 'Incorrect client argument or quoting'}
    if($WindowStyle -ne 'Hidden'){throw 'Helper must remain hidden'}
    if($manifest.sourceDirectory -ne (Join-Path $FixtureRoot 'components\supplier-hook\4.1.8.27')){throw 'Bundled source was not used'}
    $global:supplierFixtureLaunches++
    [pscustomobject]@{Id=42}
}
try {
    & (Join-Path $FixtureRoot 'scripts\launch-supplier-hook.ps1')
    if($global:supplierFixtureLaunches -ne 1){throw 'Expected exactly one mocked launch'}
    $ini=Get-Content (Join-Path $env:APPDATA 'WechatTools\config.ini') -Raw
    if($ini -notmatch 'HttpServerHost = http://127\.0\.0\.1'){throw 'Incorrect bind host'}
    if($ini -notmatch 'HttpServerPort = 19088' -or $ini -notmatch 'RecvHttpUrl = http://127\.0\.0\.1:30001/'){throw 'Internal endpoints must be automatic'}
    . (Join-Path $FixtureRoot 'scripts\supplier-runtime-check.ps1')
    function Get-NetTCPConnection {param($LocalPort,$State,$ErrorAction);[pscustomobject]@{LocalAddress='0.0.0.0';OwningProcess=99}}
    try{Wait-SupplierRuntime -Executable 'fixture' -Dll $global:supplierFixtureDll -Port 19088;throw 'Wildcard listener accepted'}catch{if($_.Exception.Message -notlike 'HOOK_NON_LOOPBACK_LISTENER*'){throw}}
    if(-not(Test-SupplierListenerAddress -Address '0.0.0.0' -DllSha256 '0f66f21d86d8d273e6da0fb8d0fbeae59fa0a501e633504aed52f77b79c7a528')){throw 'Known supplier listener rejected'}
    function Get-NetTCPConnection {param($LocalPort,$State,$ErrorAction)}
    try{Wait-SupplierRuntime -Executable 'fixture' -Dll 'fixture' -Port 19088 -TimeoutSeconds 0;throw 'Missing listener accepted'}catch{if($_.Exception.Message -notlike 'HOOK_RUNTIME_NOT_READY*'){throw}}
}finally{
    # This directory is created exclusively by this fixture, outside the user's runtime.
    if((Split-Path $env:LOCALAPPDATA -Leaf) -match '^supplier-ascii-[a-f0-9]{32}$'){Remove-Item -LiteralPath $env:LOCALAPPDATA -Recurse -Force -ErrorAction SilentlyContinue}
}
Write-Output 'launch-contract-ok'
