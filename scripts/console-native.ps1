param([ValidateSet('exe','folder','workspace')][string]$Kind)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
if ($Kind -in @('folder','workspace')) {
    $dialog = [Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = if ($Kind -eq 'workspace') { 'Select the workspace directory' } else { 'Select a folder' }
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }
} else {
    $dialog = [Windows.Forms.OpenFileDialog]::new()
    $dialog.Filter = 'Programs (*.exe)|*.exe|All files (*.*)|*.*'
    $dialog.CheckFileExists = $true
    if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }
}
$dialog.Dispose()
