$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $bundleRoot
$runtimeRoot = Join-Path $bundleRoot "runtime"
$suspendRoot = Join-Path $runtimeRoot "suspended-overlay"
$manifestPath = Join-Path $bundleRoot "install-state.json"
$markerPath = Join-Path $runtimeRoot "suspended.json"

if (-not (Test-Path $markerPath)) {
  Write-Host "AI bus is not suspended."
  exit 0
}

$marker = Get-Content $markerPath -Raw | ConvertFrom-Json

foreach ($relativePath in $marker.files) {
  $source = Join-Path $suspendRoot $relativePath
  if (-not (Test-Path $source)) {
    continue
  }

  $destination = Join-Path $repoRoot $relativePath
  $parent = Split-Path -Parent $destination
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
  }

  Move-Item -Path $source -Destination $destination -Force
}

if (Test-Path $suspendRoot) {
  Remove-Item $suspendRoot -Recurse -Force
}
Remove-Item $markerPath -Force

if (-not (Test-Path $manifestPath)) {
  throw "install-state.json is missing; cannot confirm installed overlay."
}

Write-Host "AI bus resumed for repo: $repoRoot"
