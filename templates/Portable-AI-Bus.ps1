param(
  [Parameter(Position = 0)]
  [string]$Command = "",
  [Parameter(Position = 1)]
  [string]$Task = "",
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

$normalized = $Command.ToLowerInvariant()

switch ($normalized) {
  { $_ -in @("start", "init", "begin", "run") } {
    Assert-BusToken -Value $Bus -Action "Start"
    $startArgs = @(
      "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $bundleRoot "activate.ps1"),
      "-Task", $Task,
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
  { $_ -in @("remove", "uninstall", "delete") } {
    Assert-BusToken -Value $Bus -Action "Remove"
    & powershell -ExecutionPolicy Bypass -File (Join-Path $bundleRoot "uninstall.ps1")
    return
  }
  default {
    throw "Usage: Portable-AI-Bus <start|suspend|resume|status|prompt|watch|remove> [task] [goal] -Bus Portable-AI-Bus [-Watch]"
  }
}
