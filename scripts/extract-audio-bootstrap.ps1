param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
# Only called after the Node installer verifies the pinned official archive.
Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
