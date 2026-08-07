$ErrorActionPreference = 'Stop'

$allowedOrigin = 'https://permission-next.pages.dev'
$policyPaths = @(
  'HKLM:\SOFTWARE\Policies\Google\Chrome\LocalNetworkAccessAllowedForUrls',
  'HKLM:\SOFTWARE\Policies\Microsoft\Edge\LocalNetworkAccessAllowedForUrls'
)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
  Write-Error 'Administrator permission is required. Ask IT to run this installer as administrator or deploy the policy by Group Policy.'
  exit 1
}

foreach ($policyPath in $policyPaths) {
  New-Item -Path $policyPath -Force | Out-Null
  $properties = Get-ItemProperty -Path $policyPath
  $numericProperties = @($properties.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' })
  $alreadyConfigured = $numericProperties | Where-Object { $_.Value -eq $allowedOrigin }
  if ($alreadyConfigured) { continue }

  $usedNumbers = @($numericProperties | ForEach-Object { [int]$_.Name })
  $nextNumber = if ($usedNumbers.Count) { ($usedNumbers | Measure-Object -Maximum).Maximum + 1 } else { 1 }
  New-ItemProperty `
    -Path $policyPath `
    -Name ([string]$nextNumber) `
    -PropertyType String `
    -Value $allowedOrigin `
    -Force | Out-Null
}

Write-Host 'Permission Next browser policy installed for Chrome and Microsoft Edge.' -ForegroundColor Green
Write-Host 'Close and reopen the browser, then use https://permission-next.pages.dev/Permission_Next' -ForegroundColor Yellow
