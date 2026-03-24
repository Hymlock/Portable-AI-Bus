param(
  [Parameter(Position = 0)]
  [string]$Command = "",
  [Parameter(Position = 1)]
  [string]$PathOrTask = "",
  [Parameter(Position = 2)]
  [string]$Goal = "",
  [string]$Bus = "",
  [switch]$Watch
)

$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$requiredBusToken = "Portable-AI-Bus"

function Assert-BusToken {
  param(
    [string]$Value,
    [string]$Action
  )

  if ($Value -ne $requiredBusToken) {
    throw "$Action requires -Bus Portable-AI-Bus"
  }
}

function Start-DetachedWatcher([string]$repoPath) {
  $watchScript = Join-Path $repoPath ".ai-bus\bin\ai_bus.js"
  if (-not (Test-Path $watchScript)) {
    throw "Missing watcher script: $watchScript"
  }

  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command", "Set-Location '$repoPath'; node '.ai-bus\bin\ai_bus.js' watch"
  ) | Out-Null
}

function Copy-BundleToRepo([string]$targetRepoPath) {
  if (-not (Test-Path $targetRepoPath)) {
    throw "Repo path does not exist: $targetRepoPath"
  }

  $targetBusPath = Join-Path $targetRepoPath ".ai-bus"
  if (Test-Path $targetBusPath) {
    Remove-Item $targetBusPath -Recurse -Force
  }

  Copy-Item -Path $bundleRoot -Destination $targetBusPath -Recurse -Force
  return $targetBusPath
}

$normalized = $Command.ToLowerInvariant()

switch ($normalized) {
  { $_ -in @("install", "setup", "enable") } {
    Assert-BusToken -Value $Bus -Action "Install"
    if ([string]::IsNullOrWhiteSpace($PathOrTask)) {
      throw "Install requires a repo path."
    }

    $repoPath = (Resolve-Path $PathOrTask).Path
    $targetBusPath = Copy-BundleToRepo $repoPath
    $activateArgs = @(
      "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $targetBusPath "activate.ps1")
    )
    & powershell @activateArgs
    if ($Watch) {
      Start-DetachedWatcher $repoPath
    }
    Write-Host "Portable AI bus installed into repo: $repoPath"
    return
  }
  { $_ -in @("start", "init", "begin", "run") } {
    Assert-BusToken -Value $Bus -Action "Start"
    $repoPath = (Get-Location).Path
    $startArgs = @(
      "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $bundleRoot "activate.ps1"),
      "-Task", $PathOrTask,
      "-Goal", $Goal
    )
    if ($Watch) {
      $startArgs += "-Watch"
    }
    & powershell @startArgs
    return
  }
  { $_ -in @("suspend", "pause", "disable") } {
    Assert-BusToken -Value $Bus -Action "Suspend"
    & powershell -ExecutionPolicy Bypass -File (Join-Path $bundleRoot "suspend.ps1")
    return
  }
  { $_ -in @("resume", "restore", "continue") } {
    Assert-BusToken -Value $Bus -Action "Resume"
    & powershell -ExecutionPolicy Bypass -File (Join-Path $bundleRoot "resume.ps1")
    return
  }
  { $_ -in @("remove", "uninstall", "delete") } {
    Assert-BusToken -Value $Bus -Action "Remove"
    & powershell -ExecutionPolicy Bypass -File (Join-Path $bundleRoot "uninstall.ps1")
    return
  }
  { $_ -in @("status", "state", "check") } {
    & node (Join-Path $bundleRoot "bin\ai_bus.js") status
    return
  }
  { $_ -in @("prompt", "next") } {
    & node (Join-Path $bundleRoot "bin\ai_bus.js") prompt
    return
  }
  { $_ -in @("watch", "monitor") } {
    & node (Join-Path $bundleRoot "bin\ai_bus.js") watch
    return
  }
  default {
    throw "Usage: Portable-AI-Bus <install|start|suspend|resume|status|prompt|watch|remove> [repoPath|task] [goal] -Bus Portable-AI-Bus [-Watch]"
  }
}
