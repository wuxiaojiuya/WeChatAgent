param([switch]$PrepareOnly)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$config=Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($config.hook.backend -ne 'supplier-http' -or $config.hook.expectedVersion -ne '4.1.8.27'){throw 'HOOK_PROVIDER_CONFIG_INVALID'}
$source=Join-Path $root 'components\supplier-hook\4.1.8.27'
if(-not(Test-Path -LiteralPath (Join-Path $source 'files.sha256.json') -PathType Leaf)){throw 'HOOK_BUNDLED_COMPONENT_MISSING: Restore the bundled project components.'}
$bundledFiles=Get-Content -LiteralPath (Join-Path $source 'files.sha256.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$stage=Join-Path $root 'state\hook\supplier-4.1.8.27'
$null=New-Item -ItemType Directory -Path $stage -Force
$sha=[Security.Cryptography.SHA256]::Create()
try{$projectId=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-','').ToLowerInvariant().Substring(0,16)}finally{$sha.Dispose()}
# This supplier loader cannot load its DLL from a Unicode path.
$runtime=Join-Path $env:LOCALAPPDATA ('WeChatAgent\supplier-41827\'+$projectId)
if($runtime -match '[^\x00-\x7F]'){throw 'HOOK_ASCII_RUNTIME_REQUIRED: LOCALAPPDATA must provide an ASCII-only component path.'}
$null=New-Item -ItemType Directory -Path $runtime -Force
$manifest=@{version='4.1.8.27';sourceDirectory=$source;runtimeDirectory=$runtime;preparedAt=[DateTime]::UtcNow.ToString('o')}
foreach($spec in @(@('libGLESv1.dll','dllSha256'),@('x64 inject.exe','injectorSha256'))){
    $from=Join-Path $source $spec[0];$to=Join-Path $stage $spec[0]
    if(-not (Test-Path -LiteralPath $from -PathType Leaf)){throw ('HOOK_SUPPLIED_FILE_MISSING '+$spec[0])}
    $hash=(Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash.ToLowerInvariant()
    $expected=@($bundledFiles|Where-Object {$_.file -ceq $spec[0]})
    if($expected.Count -ne 1 -or $expected[0].sha256 -cne $hash -or $expected[0].bytes -ne (Get-Item -LiteralPath $from).Length){throw 'HOOK_BUNDLED_COMPONENT_INTEGRITY_FAILED'}
    if(Test-Path -LiteralPath $to){if((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash){throw 'HOOK_STAGED_FILE_CHANGED: Stop matching WeChat and archive the previous stage before changing binaries.'}}
    else{Copy-Item -LiteralPath $from -Destination $to}
    $runtimeFile=Join-Path $runtime $spec[0]
    if(Test-Path -LiteralPath $runtimeFile){
        if((Get-FileHash -LiteralPath $runtimeFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash){throw 'HOOK_RUNTIME_FILE_CHANGED'}
    }else{Copy-Item -LiteralPath $to -Destination $runtimeFile}
    $manifest[$spec[1]]=$hash
}
[IO.File]::WriteAllText((Join-Path $stage 'manifest.json'),($manifest|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$upstream=[Uri]'http://127.0.0.1:19088'
$gateway=[Uri]'http://127.0.0.1:30001'
if($upstream.Host -ne '127.0.0.1' -or $gateway.Host -ne '127.0.0.1'){throw 'HOOK_LOOPBACK_REQUIRED'}
$token=(Get-Content -LiteralPath (Join-Path $root 'state\hook\native-token.txt') -Raw).Trim()
if($token -notmatch '^[a-f0-9]{64}$'){throw 'HOOK_TOKEN_MISSING'}
$ini=Join-Path $env:APPDATA 'WechatTools\config.ini'
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $ini) -Force
$content=if(Test-Path -LiteralPath $ini){[IO.File]::ReadAllText($ini)}else{"[config]`r`n"}
if($content -notmatch '(?im)^\[config\]\s*$'){throw 'HOOK_CONFIG_SECTION_MISSING'}
if(Test-Path -LiteralPath $ini){$backup=Join-Path $stage 'supplier-config.before.ini';if(-not(Test-Path -LiteralPath $backup)){Copy-Item -LiteralPath $ini -Destination $backup}}
$values=[ordered]@{HttpServerHost='http://127.0.0.1';HttpServerPort=[string]$upstream.Port;RunHttp='1';RecvMessageMode='http';RecvHttpUrl=($gateway.GetLeftPart([UriPartial]::Authority)+'/api/recvMsg/'+$token);TcpOpen='0';befor_login_tcp='0'}
# Only edit the supplier's config section; preserve unrelated sections and keys.
$lines=[Collections.Generic.List[string]]::new();$inside=$false;$written=@{}
foreach($line in ($content -split '\r?\n')){
    if($line -match '^\s*\[([^\]]+)\]'){
        if($inside){foreach($key in $values.Keys){if(-not $written.ContainsKey($key)){$lines.Add($key+' = '+$values[$key]);$written[$key]=$true}}}
        $inside=$Matches[1] -ieq 'config';$lines.Add($line);continue
    }
    if($inside -and $line -match '^\s*([^=]+?)\s*='){
        $key=$Matches[1].Trim();if($values.Contains($key)){if(-not $written.ContainsKey($key)){$lines.Add($key+' = '+$values[$key]);$written[$key]=$true};continue}
    }
    $lines.Add($line)
}
if($inside){foreach($key in $values.Keys){if(-not $written.ContainsKey($key)){$lines.Add($key+' = '+$values[$key])}}}
[IO.File]::WriteAllText($ini,($lines -join "`r`n"),[Text.UTF8Encoding]::new($false))
Write-Output 'Bundled 4.1.8.27 Hook prepared; internal HTTP configuration saved automatically.'
if($PrepareOnly){exit 0}
$exe=if([IO.Path]::IsPathRooted($config.hook.wechatExecutable)){
    [IO.Path]::GetFullPath($config.hook.wechatExecutable)
}else{
    [IO.Path]::GetFullPath((Join-Path $root $config.hook.wechatExecutable))
}
if(-not(Test-Path -LiteralPath $exe)){throw 'HOOK_MATCHING_CLIENT_MISSING: Install/extract WeChat 4.1.8.27 and choose its Weixin.exe in Connections.'}
if((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne '4.1.8.27'){throw 'HOOK_VERSION_MISMATCH'}
$signature=Get-AuthenticodeSignature -LiteralPath $exe
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent'){throw 'HOOK_CLIENT_SIGNATURE_INVALID'}
$running=@(Get-Process Weixin,WeChat -ErrorAction SilentlyContinue)
if($running.Count){throw 'HOOK_EXIT_WECHAT_FIRST: Exit the existing WeChat from its tray before opening the supplied 4.1.8.27 Hook. No process was terminated.'}
if(@(Get-NetTCPConnection -LocalPort $upstream.Port -State Listen -ErrorAction SilentlyContinue).Count){throw 'HOOK_UPSTREAM_PORT_IN_USE'}
# The supplier injector takes: executable, DLL, JSON initialization parameters.
$parameters=@{tcp_ip='127.0.0.1';tcp_port=61108;http_port=$upstream.Port;http_server_port=$upstream.Port;http_callback_url=$values.RecvHttpUrl}|ConvertTo-Json -Compress
$arguments='"'+$exe+'" "'+(Join-Path $runtime 'libGLESv1.dll')+'" "'+$parameters.Replace('"','\"')+'"'
$process=Start-Process -FilePath (Join-Path $runtime 'x64 inject.exe') -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $exe) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stage 'injector.stdout.log') -RedirectStandardError (Join-Path $stage 'injector.stderr.log')
. (Join-Path $PSScriptRoot 'supplier-runtime-check.ps1')
$clientPid=Wait-SupplierRuntime -Executable $exe -Dll (Join-Path $runtime 'libGLESv1.dll') -Port $upstream.Port
Write-Output ('Supplier DLL and HTTP listener verified (WeChat PID '+$clientPid+'). This supplied DLL binds all IPv4 interfaces; project requests use 127.0.0.1. Log in, then use Connect and verify. No chat messages were sent.')
