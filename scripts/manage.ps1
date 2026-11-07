param([ValidateSet('start','stop','restart','status','prepare')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root 'state'
$recordFile = Join-Path $stateDir 'runtime.json'
. (Join-Path $PSScriptRoot 'python-service-owner.ps1')
$script:record = @{}
if (Test-Path -LiteralPath $recordFile) {
    $saved = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $script:record[$property.Name] = $property.Value }
}
function Save-Record { $script:record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $recordFile -Encoding UTF8 }
function Test-Port([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try { $task = $client.ConnectAsync('127.0.0.1',$Port); return ($task.Wait(700) -and $client.Connected) }
    catch { return $false } finally { $client.Dispose() }
}
function Owned-Process($Item,[switch]$AllowStale) {
    if (-not $Item) { return $null }
    $markerRoot = [IO.Path]::GetFullPath($root).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (-not $Item.marker -or -not [IO.Path]::IsPathRooted([string]$Item.marker)) { throw 'Cannot verify recorded process marker; refusing to stop it.' }
    $markerInRoot = [IO.Path]::GetFullPath([string]$Item.marker).StartsWith($markerRoot,[StringComparison]::OrdinalIgnoreCase)
    if (-not $markerInRoot) {
        if ($AllowStale) { Write-Host 'Discarded a foreign installation process record; unrelated process was not stopped.'; return $null }
        throw 'Recorded process belongs to another installation; refusing to stop or reuse it.'
    }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Item.pid)
    if (-not $process) { return $null }
    if (-not $process.ExecutablePath -or -not $process.CommandLine) { throw 'Cannot verify recorded process identity; refusing to stop it.' }
    if ($process.ExecutablePath -ne $Item.exe -or $process.CommandLine.IndexOf($Item.marker,[StringComparison]::OrdinalIgnoreCase) -lt 0) {
        if ($AllowStale) { Write-Host 'Discarded a stale service process record; unrelated process was not stopped.'; return $null }
        throw 'Recorded PID no longer belongs to WeChatAgent; refusing to stop it.'
    }
    return $process
}
function Stop-Services([string[]]$ServiceNames = @('adapter','bridge','receiver','reader','weflow','feiyu','asr')) {
    $stopErrors = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $ServiceNames) {
        if ($script:record.ContainsKey($name)) {
          try {
            $item = $script:record[$name]
            if (Owned-Process $item -AllowStale) {
                $stoppedGracefully = $false
                if (-not $stoppedGracefully) {
                    try { Stop-Process -Id $item.pid -ErrorAction Stop }
                    catch { if (Owned-Process $item -AllowStale) { throw } }
                    try { Wait-Process -Id $item.pid -Timeout 10 -ErrorAction Stop }
                    catch { if (Owned-Process $item -AllowStale) { throw 'Managed process did not stop before the deadline.' } }
                }
            }
            $script:record.Remove($name); Save-Record
            Write-Output ($name + ' stopped.')
          } catch {
            $stopErrors.Add($name)
            Write-Output ($name + ' could not be stopped; its ownership record was retained.')
          }
        }
    }
    if ($stopErrors.Count) { throw ('Managed services could not be stopped: ' + ($stopErrors -join ', ') + '. See state/logs/shutdown.log.') }
}
function Get-PortBindings([int]$Port) {
    try { $connections=@(Get-NetTCPConnection -LocalPort $Port -ErrorAction Stop) }
    catch {
        if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return @() }
        throw ('SERVICE_PORT_INSPECTION_FAILED port='+$Port)
    }
    # These services bind IPv4 loopback. A separate IPv6-only listener may
    # legitimately share the number; the IPv4 bind probe remains final.
    return @($connections | Where-Object { [string]$_.State -in @('Listen','Bound') -and $_.LocalAddress -in @('127.0.0.1','0.0.0.0') })
}
function Assert-PortBindable([string]$Name,[int]$Port) {
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$Port)
    try { $listener.Server.ExclusiveAddressUse=$true; $listener.Start() }
    catch {
        $failure=$_.Exception;$nativeCode='UNKNOWN'
        while($failure){if($failure -is [Net.Sockets.SocketException]){$nativeCode=[string]$failure.NativeErrorCode;break};$failure=$failure.InnerException}
        $reason=if($nativeCode -eq '10048'){'SERVICE_PORT_IN_USE'}elseif($nativeCode -eq '10013'){'SERVICE_PORT_DENIED'}else{'SERVICE_PORT_UNAVAILABLE'}
        throw ($reason+' service='+$Name+' port='+$Port+' system='+$nativeCode)
    } finally { $listener.Stop() }
}
function Test-ServiceReady([string]$Name,[int]$Port,[int]$ExpectedProcessId) {
    $listeners=@(Get-PortBindings $Port | Where-Object { [string]$_.State -eq 'Listen' })
    if(-not $listeners.Count){return $false}
    $owners=@($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if($Name -in @('receiver','feiyu','asr') -and $owners.Count -eq 1 -and $owners[0] -ne $ExpectedProcessId){
        $item=$script:record[$Name]
        if($item -and $item.pid -eq $ExpectedProcessId -and (Resolve-PythonServiceOwner -ParentProcessId $ExpectedProcessId -ListenerProcessId $owners[0] -Python $item.exe -Marker $item.marker)){return $false}
    }
    if(@($owners | Where-Object {[int]$_ -ne $ExpectedProcessId}).Count){throw ('SERVICE_PORT_OWNER_MISMATCH service='+$Name+' port='+$Port+' expectedPid='+$ExpectedProcessId+' owners='+($owners -join ','))}
    if($Name -eq 'feiyu'){
        try{$health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$Port+'/health') -TimeoutSec 1}catch{return $false}
        return $health.status -eq 'ok' -and $health.version -is [string]
    }
    if($Name -eq 'asr'){
        try{$health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$Port+'/health') -TimeoutSec 1}catch{return $false}
        return $health.status -eq 'ok' -and $health.project -eq 'WeChatAgent local ASR'
    }
    if($Name -eq 'adapter'){
        try{$health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$Port+'/status') -TimeoutSec 1}catch{return $false}
        $healthPid=0
        if(-not [int]::TryParse([string]$health.pid,[ref]$healthPid) -or $health.project -ne 'WeChatAgent' -or $health.component -ne 'adapter' -or $health.statusVersion -ne 1 -or $health.backend -ne 'wechat-hook' -or $healthPid -ne $ExpectedProcessId -or $health.projectRoot -isnot [string]){throw ('ADAPTER_IDENTITY_MISMATCH port='+$Port+' expectedPid='+$ExpectedProcessId)}
        $sameRoot=$false;try{$sameRoot=[IO.Path]::GetFullPath($health.projectRoot).TrimEnd('\','/') -eq [IO.Path]::GetFullPath($root).TrimEnd('\','/')}catch{}
        if(-not $sameRoot){throw ('ADAPTER_IDENTITY_MISMATCH port='+$Port+' expectedPid='+$ExpectedProcessId)}
        return $health.ready -eq $true
    }
    return $true
}
function Start-ServiceProcess([string]$Name,[string]$Exe,[string]$Arguments,[string]$Directory,[string]$Marker,[int]$Port,[bool]$Visible) {
    $bindings=@(Get-PortBindings $Port)
    if($bindings.Count){
        $item=$script:record[$Name];$existing=$null
        try{$existing=Owned-Process $item}catch{}
        $owners=@($bindings | Select-Object -ExpandProperty OwningProcess -Unique)
        if($Name -in @('receiver','feiyu','asr') -and $existing -and $owners.Count -eq 1 -and $owners[0] -ne $item.pid){
            $child=Resolve-PythonServiceOwner -ParentProcessId $item.pid -ListenerProcessId $owners[0] -Python $item.exe -Marker $Marker
            if($child){$item=@{pid=$child.ProcessId;exe=$child.ExecutablePath;marker=$Marker};$script:record[$Name]=$item;Save-Record}
        }
        if(-not $existing -or @($owners | Where-Object {[int]$_ -ne [int]$item.pid}).Count){throw ('SERVICE_PORT_IN_USE service='+$Name+' port='+$Port+' owners='+($owners -join ','))}
        $process=Get-Process -Id ([int]$item.pid) -ErrorAction Stop
    }else{
        # A failed connection does not prove the port can be bound. This
        # preflight is advisory; the child listener and identity remain final.
        Assert-PortBindable $Name $Port
        $style = if ($Visible) { 'Normal' } else { 'Hidden' }
        $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle $style -PassThru -RedirectStandardOutput (Join-Path $stateDir ('logs\'+$Name+'.stdout.log')) -RedirectStandardError (Join-Path $stateDir ('logs\'+$Name+'.stderr.log'))
        $script:record[$Name] = @{pid=$process.Id;exe=$Exe;marker=$Marker}; Save-Record
    }
    $watch=[Diagnostics.Stopwatch]::StartNew()
    do {
        $process.Refresh()
        if ($process.HasExited) {
            $failureLog = Join-Path $stateDir ('logs\'+$Name+'.stderr.log')
            if (Test-Path -LiteralPath $failureLog) {
                Get-Content -LiteralPath $failureLog -Encoding UTF8 -Tail 30 | ForEach-Object { Write-Output $_ }
            }
            throw ($Name + ' exited; see state/logs/'+$Name+'.stderr.log')
        }
        if($Name -in @('receiver','feiyu','asr')){
            $owners=@(Get-PortBindings $Port | Where-Object State -eq 'Listen' | Select-Object -ExpandProperty OwningProcess -Unique)
            if($owners.Count -eq 1 -and $owners[0] -ne $process.Id){
                $item=$script:record[$Name]
                $child=Resolve-PythonServiceOwner -ParentProcessId $process.Id -ListenerProcessId $owners[0] -Python $item.exe -Marker $Marker
                if($child){$process=Get-Process -Id $child.ProcessId -ErrorAction Stop;$script:record[$Name]=@{pid=$child.ProcessId;exe=$child.ExecutablePath;marker=$Marker};Save-Record}
            }
        }
        if(Test-ServiceReady $Name $Port ([int]$process.Id)){return}
        Start-Sleep -Milliseconds 250
    }while($watch.Elapsed.TotalSeconds -lt 20)
    throw ('SERVICE_START_TIMEOUT service='+$Name+' port='+$Port+'. Finish its setup or restart this instance before retrying.')
}
function Show-Status($Config) {
    Write-Output 'Sender: bundled supplier Hook 4.1.8.27'
    foreach ($property in $Config.ports.PSObject.Properties) { Write-Output ($property.Name + ': ' + (Test-Port ([int]$property.Value))) }
    if (Test-Port ([int]$Config.ports.receiver)) {
        $api = Get-Content (Join-Path $stateDir 'wechat-io-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $receiver = Invoke-RestMethod ($api.receiver_base_url + '/api/v1/receiver/status') -Headers @{Authorization='Bearer '+$api.receiver_token} -TimeoutSec 3
        Write-Output ('Hook message receiver healthy: ' + (-not [bool]$receiver.lastError))
    }
    if (Test-Port ([int]$Config.ports.adapter)) {
        $status = Invoke-RestMethod ('http://127.0.0.1:'+$Config.ports.adapter+'/status') -TimeoutSec 3
        Write-Output ('OneBot connected: '+$status.ob_connected)
        Write-Output ('Receiver connected: '+$status.receiver_connected)
        Write-Output ('Hook ready: '+$status.hook_ready)
        if ($status.last_error) { Write-Output ('Hook last error: '+$status.last_error) }
    }
    Write-Output ('Logs: '+(Join-Path $stateDir 'logs'))
}
function Initialize-SupplierConnection($Config,[string]$Node,[string]$ScriptsDirectory) {
    if ($Config.hook.backend -ne 'supplier-http') { return }
    $bindingFile=Join-Path $stateDir 'hook\connection.json'
    $validBinding=$false
    if (Test-Path -LiteralPath $bindingFile -PathType Leaf) {
        try {
            $binding=Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $validBinding=$binding.backend -eq 'supplier-http' -and [string]$binding.ownWxid -cmatch '^[A-Za-z0-9_-]{1,128}$' -and $binding.version -eq 1 -and $binding.wechatVersion -eq '4.1.8.27'
        } catch { $validBinding=$false }
    }
    $active=@($Config.ports.receiver,$Config.ports.adapter,$Config.ports.onebot | Where-Object { Test-Port ([int]$_) })
    if ($active.Count) {
        if (-not $validBinding) { throw 'HOOK_STOP_SERVICES_BEFORE_BIND: Stop the assistant before preparing its Hook connection.' }
        Write-Output 'Reusing the running Hook message services; login metadata is not queried again.'
        return
    }
    # Prepare only at an explicit start with the message services stopped. The
    # connection reads single-login metadata once; running dispatch never polls it.
    Write-Output 'Preparing the built-in Hook connection before starting the assistant...'
    & $Node (Join-Path $ScriptsDirectory 'supplier-connect.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'HOOK_STARTUP_CONNECT_FAILED: See the Hook connection error above. Finish WeChat login, then start the assistant again.' }
    $binding=Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($binding.backend -ne 'supplier-http' -or [string]$binding.ownWxid -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or $binding.version -ne 1 -or $binding.wechatVersion -ne '4.1.8.27') { throw 'HOOK_ACCOUNT_METADATA_INVALID' }
}
if ($Action -eq 'stop') { Stop-Services; exit 0 }
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Invalid project configuration.' }
$startupConfiguration = Get-Content (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8
$config = $startupConfiguration | ConvertFrom-Json
$hookSender = $config.runtime.sender -eq 'wechat-hook'
if ($Action -eq 'prepare') { exit 0 }
if ($Action -eq 'status') { Show-Status $config; exit 0 }
if ($Action -eq 'restart') { Stop-Services }
elseif ($script:record.ContainsKey('reader') -or $script:record.ContainsKey('weflow')) { Stop-Services -ServiceNames @('adapter','bridge','reader','weflow') }
Initialize-SupplierConnection $config $node $PSScriptRoot
# Connection preparation may restore this account's saved chat settings.
$preparedConfiguration = Get-Content (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8
if ($config.hook.backend -eq 'supplier-http' -and $preparedConfiguration -ne $startupConfiguration) {
    & $node (Join-Path $PSScriptRoot 'project-config.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Invalid project configuration after Hook connection preparation.' }
}
$config = Get-Content (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$python = (Get-Command $config.runtime.python -ErrorAction Stop).Source
$names = @('SOCIAL_DSH_TOKEN','PYTHONUTF8','PYTHONUNBUFFERED','WECHATAGENT_LOG_DIR','WECHATAGENT_STATE_DIR')
$previous = @{}; foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
    $env:PYTHONUTF8='1'; $env:PYTHONUNBUFFERED='1'
    $asrPython=Join-Path $root 'state\media-runtime\venv\Scripts\python.exe'
    if((Test-Path -LiteralPath $asrPython) -and (Test-Path -LiteralPath (Join-Path $root 'state\media-runtime\models\whisper-small\model.bin'))){
        $asrEntry=Join-Path $PSScriptRoot 'local-speech-service.py'
        Start-ServiceProcess 'asr' $asrPython ('"'+$asrEntry+'"') $root $asrEntry 9881 $false
    }
    $feiyuRuntime=Join-Path $root 'state\maintenance\audio-capabilities\feiyu-tts'
    if(Test-Path -LiteralPath (Join-Path $feiyuRuntime 'voice-service.json')){
        $feiyuPython=Join-Path $feiyuRuntime 'venv\Scripts\python.exe'
        if(-not(Test-Path -LiteralPath $feiyuPython)){throw 'FEIYU_LOCAL_RUNTIME_MISSING'}
        $feiyuEntry=Join-Path $PSScriptRoot 'feiyu-service.py'
        Start-ServiceProcess 'feiyu' $feiyuPython ('"'+$feiyuEntry+'"') $root $feiyuEntry 9880 $false
    }
    $receiverEntry = Join-Path $PSScriptRoot 'hook-receiver.py'
    Start-ServiceProcess 'receiver' $python ('"'+$receiverEntry+'"') $root $receiverEntry ([int]$config.ports.receiver) $false
    if ($hookSender) {
        & $node (Join-Path $PSScriptRoot 'hook-onebot.mjs') --check
        if ($LASTEXITCODE -ne 0) { throw 'WeChat-Hook is not ready. Use Open WeChat in WeChatAgent, finish login, then start again. Check the error above and state/logs/hook-init.log for native initialization details.' }
    }
    $env:SOCIAL_DSH_TOKEN = (Get-Content (Join-Path $stateDir 'social-dsh-token.txt') -Raw).Trim()
    & $node (Join-Path $PSScriptRoot 'dsh-refresh.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'DSH_CONFIGURATION_APPLY_FAILED: See the configuration reload error above.' }
    $dshUrl = 'http://127.0.0.1:'+$config.ports.dshPlugin+'/health'
    if (-not (Test-Port ([int]$config.ports.dshPlugin))) {
        if (-not $config.runtime.dshDesktop -or -not (Test-Path -LiteralPath $config.runtime.dshDesktop)) { throw 'DSH_NOT_CONFIGURED: Install DSH from the setup link, then select its executable and save settings.' }
        & (Join-Path $PSScriptRoot 'launch-dsh.ps1')
        for($i=0;$i -lt 60 -and -not (Test-Port ([int]$config.ports.dshPlugin));$i++){Start-Sleep -Milliseconds 250}
        if (-not (Test-Port ([int]$config.ports.dshPlugin))) { throw 'DSH_PLUGIN_NOT_READY: Enable the local plugin in DSH and fully reopen DSH from the tray.' }
    }
    $health = Invoke-RestMethod $dshUrl -Headers @{Authorization='Bearer '+$env:SOCIAL_DSH_TOKEN} -TimeoutSec 3
    $accountIdentityFile = Join-Path $stateDir 'hook\active-connection.json'
    if (Test-Path -LiteralPath $accountIdentityFile) {
        $accountIdentity = Get-Content -LiteralPath $accountIdentityFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($health.accountScope -ne $accountIdentity.id) { throw 'DSH_CONFIGURATION_APPLY_FAILED: The active connection did not reload; retry applying settings.' }
    }
    if ($health.ok -ne $true -or $health.project -ne 'WeChatAgent' -or [IO.Path]::GetFullPath($health.projectRoot) -ne [IO.Path]::GetFullPath($root)) { throw 'Install the DSH plugin from this project packages directory, then fully reopen DSH.' }
    if ($health.contextMode -ne 'native-session-v1') { throw 'Fully exit DSH from the tray and reopen it to load the native-session plugin.' }
    if ($health.behaviorPolicy -ne 'local-config-only-v1') { throw 'Fully reopen DSH to load the local-only behavior policy before starting WeChatAgent.' }
    if ($health.imageInput -ne 'native-attachment-v1') { throw 'Fully exit DSH from the tray and reopen it to load the image attachment plugin.' }
    $bridgeEntry = Join-Path $root 'components\qq-bridge\src\social-bridge.js'
    Start-ServiceProcess 'bridge' $node ('"'+$bridgeEntry+'" "'+(Join-Path $stateDir 'bridge-config.json')+'"') (Join-Path $root 'components\qq-bridge') $bridgeEntry ([int]$config.ports.onebot) $false
    $env:PYTHONUTF8='1'; $env:PYTHONUNBUFFERED='1'
    $env:WECHATAGENT_LOG_DIR=$null; $env:WECHATAGENT_STATE_DIR=$null
    $adapterEntry = Join-Path $PSScriptRoot 'hook-onebot.mjs'
    Start-ServiceProcess 'adapter' $node ('"'+$adapterEntry+'"') $root $adapterEntry ([int]$config.ports.adapter) $false
    for($i=0;$i -lt 20;$i++) {
        $status=Invoke-RestMethod ('http://127.0.0.1:'+$config.ports.adapter+'/status') -TimeoutSec 3
        if($status.ob_connected -and $status.receiver_connected){break}; Start-Sleep -Milliseconds 250
    }
    Show-Status $config
} finally { foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')} }
