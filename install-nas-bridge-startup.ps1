$ErrorActionPreference = 'Stop'

$startScript = Join-Path $PSScriptRoot 'start-nas-bridge.cmd'
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
  Write-Error "Missing bridge launcher: $startScript"
  exit 1
}

$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'Permission Next NAS Bridge.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $startScript
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Start Permission Next NAS Bridge at Windows sign-in'
$shortcut.Save()

Write-Host 'Permission NAS Bridge will start automatically at Windows sign-in.' -ForegroundColor Green
& $startScript
