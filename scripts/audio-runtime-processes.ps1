param([Parameter(Mandatory=$true)][string]$Runtime)
$ErrorActionPreference='Stop'
$prefix=[IO.Path]::GetFullPath($Runtime).TrimEnd('\')+'\'
$found=@(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and (
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0)
  )
})
if($found.Count -gt 0){exit 2}
exit 0
