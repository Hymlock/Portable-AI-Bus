param(
  [string[]]$Providers = @()
)

$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $bundleRoot
$templatesRoot = Join-Path $bundleRoot "templates"
$providersPath = Join-Path $bundleRoot "providers\providers.json"
$manifestPath = Join-Path $bundleRoot "install-state.json"
$excludePath = Join-Path $repoRoot ".git\info\exclude"

$managedBlockStart = "# BEGIN AI_BUS_LOCAL"
$managedBlockEnd = "# END AI_BUS_LOCAL"
$baseExcludeEntries = @(
  ".ai-bus/",
  "Start.cmd",
  "Suspend.cmd",
  "Resume.cmd",
  "Status.cmd",
  "Prompt.cmd",
  "Watch.cmd",
  "Remove.cmd",
  "docs/ai-status.md",
  "docs/ai-plan.md",
  "docs/ai-handoff.md",
  "docs/ai-review.md",
  "docs/ai-automation.md",
  ".vscode/tasks.json",
  "tmp/ai-prompts/"
)

$sharedTemplateMap = @(
  @{ Source = "Portable-AI-Bus.cmd"; Destination = "Portable-AI-Bus.cmd" },
  @{ Source = "Portable-AI-Bus.ps1"; Destination = "Portable-AI-Bus.ps1" },
  @{ Source = "Start.cmd"; Destination = "Start.cmd" },
  @{ Source = "Suspend.cmd"; Destination = "Suspend.cmd" },
  @{ Source = "Resume.cmd"; Destination = "Resume.cmd" },
  @{ Source = "Status.cmd"; Destination = "Status.cmd" },
  @{ Source = "Prompt.cmd"; Destination = "Prompt.cmd" },
  @{ Source = "Watch.cmd"; Destination = "Watch.cmd" },
  @{ Source = "Remove.cmd"; Destination = "Remove.cmd" },
  @{ Source = "docs\ai-status.md"; Destination = "docs\ai-status.md" },
  @{ Source = "docs\ai-plan.md"; Destination = "docs\ai-plan.md" },
  @{ Source = "docs\ai-handoff.md"; Destination = "docs\ai-handoff.md" },
  @{ Source = "docs\ai-review.md"; Destination = "docs\ai-review.md" },
  @{ Source = "docs\ai-automation.md"; Destination = "docs\ai-automation.md" }
)

function Read-ProvidersConfig {
  if (-not (Test-Path $providersPath)) {
    throw "Missing provider registry: $providersPath"
  }

  $config = Get-Content $providersPath -Raw | ConvertFrom-Json
  if (-not $config.providers) {
    throw "Provider registry is missing providers."
  }
  return $config
}

function Get-ProviderById($config, [string]$providerId) {
  foreach ($provider in $config.providers) {
    if ($provider.id -eq $providerId) {
      return $provider
    }
  }
  return $null
}

function Test-ProviderDetected($provider) {
  if (-not $provider.markersAny) {
    return $false
  }

  foreach ($marker in $provider.markersAny) {
    $candidate = Join-Path $repoRoot $marker
    if (Test-Path $candidate) {
      return $true
    }
  }
  return $false
}

function Resolve-ProvidersToInstall($config) {
  if ($Providers -and $Providers.Count -gt 0) {
    $resolved = @()
    foreach ($providerId in $Providers) {
      $provider = Get-ProviderById $config $providerId
      if ($null -eq $provider) {
        throw "Unknown provider: $providerId"
      }
      $resolved += $provider
    }
    return $resolved
  }

  $detected = @()
  foreach ($provider in $config.providers) {
    if (Test-ProviderDetected $provider) {
      $detected += $provider
    }
  }

  if ($detected.Count -ge 2) {
    return $detected
  }

  if ($detected.Count -eq 1) {
    $names = ($detected | ForEach-Object { $_.displayName }) -join ", "
    Write-Warning "Only one supported agent provider was detected: $names"
    $recommended = @()
    foreach ($providerId in $config.recommendedPair) {
      $provider = Get-ProviderById $config $providerId
      if ($null -ne $provider) {
        $recommended += $provider
      }
    }
    Write-Warning "Scaffolding the recommended pair: $((($recommended | ForEach-Object { $_.displayName }) -join ', '))"
    return $recommended
  }

  $recommendedFallback = @()
  foreach ($providerId in $config.recommendedPair) {
    $provider = Get-ProviderById $config $providerId
    if ($null -ne $provider) {
      $recommendedFallback += $provider
    }
  }

  if ($recommendedFallback.Count -ge 2) {
    Write-Warning "No supported providers were detected. Falling back to the recommended pair."
    return $recommendedFallback
  }

  throw "No supported providers were detected and no recommended pair is configured."
}

function Get-ProviderTemplateMap($providersToInstall) {
  $map = @()
  foreach ($provider in $providersToInstall) {
    foreach ($entry in $provider.install) {
      $map += @{
        Source = $entry.source
        Destination = $entry.destination
      }
    }
  }
  return $map
}

function Get-ExcludeEntries($providerTemplateMap) {
  $entries = @($baseExcludeEntries)
  foreach ($entry in $sharedTemplateMap) {
    $entries += $entry.Destination
  }
  foreach ($entry in $providerTemplateMap) {
    $entries += $entry.Destination
  }
  return @($entries | Select-Object -Unique)
}

function Update-ExcludeFile($excludeEntries) {
  $existing = ""
  if (Test-Path $excludePath) {
    $existing = Get-Content $excludePath -Raw
  }

  $escapedStart = [regex]::Escape($managedBlockStart)
  $escapedEnd = [regex]::Escape($managedBlockEnd)
  $pattern = "(?ms)^$escapedStart\r?\n.*?^$escapedEnd\r?\n?"
  $cleaned = [regex]::Replace($existing, $pattern, "")
  $blockLines = @($managedBlockStart) + @($excludeEntries) + @($managedBlockEnd, "")
  $block = $blockLines -join [Environment]::NewLine
  $updated = ($cleaned.TrimEnd(), "", $block) -join [Environment]::NewLine
  Set-Content -Path $excludePath -Value $updated -NoNewline
}

function Ensure-ParentDirectory([string]$targetPath) {
  $parent = Split-Path -Parent $targetPath
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
  }
}

function Install-File([string]$sourceRelative, [string]$destinationRelative) {
  $source = Join-Path $templatesRoot $sourceRelative
  $destination = Join-Path $repoRoot $destinationRelative

  if (-not (Test-Path $source)) {
    throw "Missing template: $sourceRelative"
  }

  Ensure-ParentDirectory $destination
  Copy-Item -Path $source -Destination $destination -Force
  return $destinationRelative
}

function Compare-FileContent([string]$leftPath, [string]$rightPath) {
  if ((-not (Test-Path $leftPath)) -or (-not (Test-Path $rightPath))) {
    return $false
  }
  return (Get-Content $leftPath -Raw) -eq (Get-Content $rightPath -Raw)
}

$config = Read-ProvidersConfig
$providersToInstall = Resolve-ProvidersToInstall $config
$providerTemplateMap = Get-ProviderTemplateMap $providersToInstall
$excludeEntries = Get-ExcludeEntries $providerTemplateMap

Update-ExcludeFile $excludeEntries

$installed = @()
foreach ($entry in ($sharedTemplateMap + $providerTemplateMap)) {
  $installed += Install-File $entry.Source $entry.Destination
}

$tasksPath = Join-Path $repoRoot ".vscode\tasks.json"
$tasksTemplatePath = Join-Path $templatesRoot ".vscode\tasks.json"
if (-not (Test-Path $tasksPath)) {
  $installed += Install-File ".vscode\tasks.json" ".vscode\tasks.json"
} elseif (Compare-FileContent $tasksPath $tasksTemplatePath) {
  $installed += ".vscode\tasks.json"
} else {
  Write-Host "Skipped .vscode\tasks.json because it already exists."
}

$manifest = @{
  installedAt = [DateTime]::UtcNow.ToString("o")
  installedFiles = $installed
  providers = @($providersToInstall | ForEach-Object { $_.id })
} | ConvertTo-Json -Depth 4

Set-Content -Path $manifestPath -Value $manifest
Write-Host "Portable AI bus installed locally for repo: $repoRoot"
Write-Host "Providers: $((($providersToInstall | ForEach-Object { $_.displayName }) -join ', '))"
