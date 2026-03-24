$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $bundleRoot
$runtimeRoot = Join-Path $bundleRoot "runtime"
$suspendRoot = Join-Path $runtimeRoot "suspended-overlay"
$manifestPath = Join-Path $bundleRoot "install-state.json"
$markerPath = Join-Path $runtimeRoot "suspended.json"

if (-not (Test-Path $manifestPath)) {
  throw "AI bus is not installed in this repo."
}

if (Test-Path $markerPath) {
  Write-Host "AI bus is already suspended."
  exit 0
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

# Keep stateless dispatchers in the repo root so the user can resume/remove
# without needing to know the raw .ai-bus/*.ps1 paths.
$keepInPlace = @(
  "Resume.cmd",
  "Portable-AI-Bus.cmd",
  "Portable-AI-Bus.ps1"
)

if (-not (Test-Path $runtimeRoot)) {
  New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
}
if (Test-Path $suspendRoot) {
  Remove-Item $suspendRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $suspendRoot | Out-Null

foreach ($relativePath in $manifest.installedFiles) {
  if ($keepInPlace -contains $relativePath) {
    continue
  }

  $source = Join-Path $repoRoot $relativePath
  if (-not (Test-Path $source)) {
    continue
  }

  $destination = Join-Path $suspendRoot $relativePath
  $parent = Split-Path -Parent $destination
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
  }

  Move-Item -Path $source -Destination $destination -Force
}

$marker = @{
  suspendedAt = [DateTime]::UtcNow.ToString("o")
  files = $manifest.installedFiles
} | ConvertTo-Json -Depth 4

Set-Content -Path $markerPath -Value $marker
Write-Host "AI bus suspended for repo: $repoRoot"
