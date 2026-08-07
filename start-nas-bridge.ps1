$ErrorActionPreference = 'Stop'

$bridgeHealthUrl = 'http://127.0.0.1:8766/api/nas/health'
$serverScript = Join-Path $PSScriptRoot 'dev-server.js'

try {
  $health = Invoke-RestMethod -Uri $bridgeHealthUrl -TimeoutSec 2
  if ($health.status -eq 'ok' -and $health.nas_access -eq $true) {
    Write-Host 'Permission NAS Bridge is already running.' -ForegroundColor Green
    exit 0
  }
  if ($health.status -eq 'ok' -and $health.nas_access -ne $true) {
    Write-Error 'Permission NAS Bridge is running, but this Windows account cannot access the NAS drive.'
    exit 1
  }
} catch {
  # The bridge is not running yet.
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error 'Node.js is required. Install Node.js, then run this file again.'
  exit 1
}
if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) {
  Write-Error "Missing NAS Bridge server: $serverScript"
  exit 1
}

$bridgeLogDirectory = Join-Path $env:LOCALAPPDATA 'PermissionNext'
New-Item -ItemType Directory -Path $bridgeLogDirectory -Force | Out-Null
$stdoutLog = Join-Path $bridgeLogDirectory 'nas-bridge.log'
$stderrLog = Join-Path $bridgeLogDirectory 'nas-bridge-error.log'

Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList @($serverScript) `
  -WorkingDirectory $PSScriptRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri $bridgeHealthUrl -TimeoutSec 2
    if ($health.status -eq 'ok' -and $health.nas_access -eq $true) {
      Write-Host 'Permission NAS Bridge started successfully.' -ForegroundColor Green
      exit 0
    }
  } catch {
    # Keep waiting for the local process to listen.
  }
}

Write-Error "Permission NAS Bridge did not start. Check: $stderrLog"
exit 1
