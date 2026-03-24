param(
  [string]$Task = "",
  [string]$Goal = "",
  [string]$Validation = "",
  [switch]$Watch
)

$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $bundleRoot

& (Join-Path $bundleRoot "install.ps1")

if (-not [string]::IsNullOrWhiteSpace($Task)) {
  $args = @((Join-Path $bundleRoot "bin\ai_bus.js"), "init", "--task", $Task)
  if (-not [string]::IsNullOrWhiteSpace($Goal)) {
    $args += @("--goal", $Goal)
  }
  if (-not [string]::IsNullOrWhiteSpace($Validation)) {
    $args += @("--validation", $Validation)
  }
  & node @args
}

Write-Host ""
Write-Host "Current prompt:"
& node (Join-Path $bundleRoot "bin\ai_bus.js") prompt

if ($Watch) {
  Write-Host ""
  Write-Host "Starting watcher. Press Ctrl+C to stop."
  & node (Join-Path $bundleRoot "bin\ai_bus.js") watch
}
