$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $bundleRoot
$manifestPath = Join-Path $bundleRoot "install-state.json"
$excludePath = Join-Path $repoRoot ".git\info\exclude"
$runtimeRoot = Join-Path $bundleRoot "runtime"
$markerPath = Join-Path $runtimeRoot "suspended.json"

$managedBlocks = @(
  @{ Start = "# BEGIN AI_BUS_LOCAL"; End = "# END AI_BUS_LOCAL" },
  @{ Start = "# BEGIN AI_BUS_BUNDLE"; End = "# END AI_BUS_BUNDLE" }
)

function Remove-ManagedBlocks {
  if (-not (Test-Path $excludePath)) {
    return
  }

  $existing = Get-Content $excludePath -Raw
  $updated = $existing
  foreach ($block in $managedBlocks) {
    $escapedStart = [regex]::Escape($block.Start)
    $escapedEnd = [regex]::Escape($block.End)
    $pattern = "(?ms)^$escapedStart\r?\n.*?^$escapedEnd\r?\n?"
    $updated = [regex]::Replace($updated, $pattern, "")
  }

  $updated = $updated.TrimEnd()
  if ([string]::IsNullOrWhiteSpace($updated)) {
    Set-Content -Path $excludePath -Value ""
    return
  }

  Set-Content -Path $excludePath -Value ($updated + [Environment]::NewLine) -NoNewline
}

function Remove-IfEmptyDirectory([string]$dirPath) {
  if ((Test-Path $dirPath) -and ((Get-ChildItem -Force $dirPath | Measure-Object).Count -eq 0)) {
    Remove-Item $dirPath -Force
  }
}

function Start-SelfDeleteBundle([string]$targetPath) {
  if (-not (Test-Path $targetPath)) {
    return
  }

  $cleanupScript = Join-Path ([IO.Path]::GetTempPath()) ("portable-ai-bus-cleanup-{0}.cmd" -f ([guid]::NewGuid().ToString("N")))
  $targetEscaped = $targetPath.Replace('"', '""')
  $currentPid = $PID
  $scriptLines = @(
    "@echo off",
    "set TARGET=$targetEscaped",
    "set WAITPID=$currentPid",
    ":wait_for_parent",
    "tasklist /FI ""PID eq %WAITPID%"" 2>NUL | find /I ""%WAITPID%"" >NUL",
    "if not errorlevel 1 (",
    "  ping 127.0.0.1 -n 2 >NUL",
    "  goto wait_for_parent",
    ")",
    "if exist ""%TARGET%"" rmdir /S /Q ""%TARGET%""",
    "del ""%~f0"""
  )

  Set-Content -Path $cleanupScript -Value ($scriptLines -join [Environment]::NewLine)
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cleanupScript -WindowStyle Hidden | Out-Null
}

if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if (Test-Path $markerPath) {
    & (Join-Path $bundleRoot "resume.ps1") | Out-Null
  }
  foreach ($relativePath in $manifest.installedFiles) {
    $absolutePath = Join-Path $repoRoot $relativePath
    if (Test-Path $absolutePath) {
      Remove-Item $absolutePath -Force
    }
  }
  Remove-Item $manifestPath -Force
}

if (Test-Path $runtimeRoot) {
  Remove-Item $runtimeRoot -Recurse -Force
}

Remove-ManagedBlocks
Remove-IfEmptyDirectory (Join-Path $repoRoot ".vscode")
$promptDir = Join-Path $repoRoot "tmp\ai-prompts"
if (Test-Path $promptDir) {
  Remove-Item $promptDir -Recurse -Force
}
Remove-IfEmptyDirectory (Join-Path $repoRoot "tmp")
Remove-IfEmptyDirectory (Join-Path $repoRoot "docs")
Start-SelfDeleteBundle $bundleRoot
Write-Host "Portable AI bus removed from repo: $repoRoot"
Write-Host "Repo-local .ai-bus cleanup scheduled."
