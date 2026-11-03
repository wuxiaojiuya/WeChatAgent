function Test-SupplierListenerAddress {
    param([string]$Address,[string]$DllSha256)
    return $Address -eq '127.0.0.1' -or ($Address -eq '0.0.0.0' -and $DllSha256 -eq '0f66f21d86d8d273e6da0fb8d0fbeae59fa0a501e633504aed52f77b79c7a528')
}
function Wait-SupplierRuntime {
    param([string]$Executable,[string]$Dll,[int]$Port,[int]$TimeoutSeconds=30)
    $deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $listeners=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
        if($listeners.Count){
            $digest=(Get-FileHash -LiteralPath $Dll -Algorithm SHA256).Hash.ToLowerInvariant()
            if(@($listeners|Where-Object {-not(Test-SupplierListenerAddress -Address $_.LocalAddress -DllSha256 $digest)}).Count){throw 'HOOK_NON_LOOPBACK_LISTENER: Unexpected listener address for this DLL build.'}
            $owners=@($listeners.OwningProcess|Select-Object -Unique)
            if($owners.Count -ne 1){throw 'HOOK_PROCESS_AMBIGUOUS'}
            $client=Get-Process -Id $owners[0] -ErrorAction Stop
            if($client.Path -ne $Executable){throw 'HOOK_PROCESS_PATH_MISMATCH'}
            if(@($client.Modules|Where-Object FileName -eq $Dll).Count){return $client.Id}
        }
        Start-Sleep -Milliseconds 250
    }while([DateTime]::UtcNow -lt $deadline)
    throw 'HOOK_RUNTIME_NOT_READY: DLL or HTTP listener missing. Injector output alone does not confirm readiness. See state/logs and state/hook/supplier-4.1.8.27.'
}
