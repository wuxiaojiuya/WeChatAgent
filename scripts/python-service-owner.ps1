function Resolve-PythonServiceOwner {
    param([int]$ParentProcessId,[int]$ListenerProcessId,[string]$Python,[string]$Marker)
    if($ParentProcessId -eq $ListenerProcessId){return $null}
    $venv=Split-Path -Parent (Split-Path -Parent $Python)
    $file=Join-Path $venv 'pyvenv.cfg'
    if(-not(Test-Path -LiteralPath $file)){return $null}
    $line=Get-Content -LiteralPath $file -Encoding UTF8|Where-Object {$_ -match '^home\s*='}|Select-Object -First 1
    if(-not $line){return $null}
    $expected=Join-Path (($line -split '=',2)[1].Trim()) 'python.exe'
    $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ParentProcessId)
    $child=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ListenerProcessId)
    if(-not $parent -or -not $child -or $parent.ExecutablePath -ne $Python -or -not $parent.CommandLine -or $parent.CommandLine.IndexOf($Marker,[StringComparison]::OrdinalIgnoreCase) -lt 0){return $null}
    if($child.ParentProcessId -ne $ParentProcessId -or $child.ExecutablePath -ne $expected -or -not $child.CommandLine -or $child.CommandLine.IndexOf($Marker,[StringComparison]::OrdinalIgnoreCase) -lt 0){return $null}
    return $child
}
