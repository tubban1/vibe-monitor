# Windows Vibe Monitor: ONE installed RC; remove obsolete QA copies only after verified replacement.
# Run in Windows PowerShell 5.1+. Requires Git, Node, npm. Never deletes source projects outside the QA allowlist.
[CmdletBinding()]
param([string]$Workspace = "$env:USERPROFILE\mcp-workspace")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$expected = "fbf260c"
$branch = "fix/rc-prod-precision-20261018"
$version = "1.0.1-rc.0"
$install = Join-Path $Workspace "vibe-monitor"
$stage = Join-Path $env:TEMP ("vibe-monitor-upgrade-"+[guid]::NewGuid().ToString("N"))
$source = Join-Path $stage "source"
$archiveDir = Join-Path $stage "archive"
$newPackage = Join-Path $stage "installed"
$configPath = Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"
$state = Join-Path $env:USERPROFILE ".vibe-monitor"
$node = (Get-Command node.exe -ErrorAction Stop).Source
function CheckExit([string]$description) {
  if ($LASTEXITCODE -ne 0) { throw "$description failed; exit=$LASTEXITCODE" }
}
New-Item -ItemType Directory -Path @($stage,$archiveDir,$Workspace) -Force | Out-Null
$finished = $false
try {
  git clone --depth 10 --branch $branch "https://github.com/tubban1/vibe-monitor.git" $source
  CheckExit "Clone"
  git -C $source checkout --detach $expected
  CheckExit "Checkout exact vetted RC"
  if ((& git -C $source rev-parse --short HEAD).Trim() -ne $expected) { throw "Unexpected RC source" }
  Push-Location $source
  try {
    npm.cmd ci --no-audit --no-fund; CheckExit "npm ci"
    npm.cmd test; CheckExit "RC tests"
    npm.cmd run build; CheckExit "RC build"
    npm.cmd pack --pack-destination $archiveDir; CheckExit "RC pack"
  } finally { Pop-Location }
  $archive = Join-Path $archiveDir "vibe-monitor-setup-1.0.1-rc.0.tgz"
  if(-not(Test-Path $archive)){throw "Expected archive not found"}
  npm.cmd install --prefix $newPackage --no-audit --no-fund $archive
  CheckExit "Install exactly one RC"
  $newEntry = Join-Path $newPackage "node_modules\@vibe-monitor\setup\dist\vibe-monitor.mjs"
  if(-not(Test-Path $newEntry)){throw "New runtime missing"}
  $actual = (& $node $newEntry --version | Out-String).Trim()
  if($actual -notmatch [regex]::Escape($version)){throw "New runtime version mismatch: $actual"}

  # Update one Antigravity entry, preserving other unrelated MCP providers.
  if(-not(Test-Path $configPath)){throw "Antigravity MCP config is missing"}
  $cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if(-not $cfg.mcpServers){throw "Antigravity config has no mcpServers"}
  $stableEntry = Join-Path $install "node_modules\@vibe-monitor\setup\dist\vibe-monitor.mjs"
  $newEnv = @{
    HOME=$env:USERPROFILE
    USERPROFILE=$env:USERPROFILE
    VIBE_MONITOR_HOME=$state
    VIBE_MONITOR_SETUP_HOME=$env:USERPROFILE
  }
  $newMcp = [pscustomobject]@{
    command=$node
    args=@($stableEntry,"mcp","--agent","antigravity")
    env=$newEnv
  }
  $configBackup = "$configPath.before-one-version-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
  Copy-Item -LiteralPath $configPath -Destination $configBackup

  # Initialize Free telemetry BEFORE touching the active installation.
  # Avoid nested double quotes in PowerShell's node -e argument handling.
  $initFile = Join-Path $source "src\telemetry.js"
  $initUri = ([Uri]::new($initFile)).AbsoluteUri
  $env:VIBE_MONITOR_HOME = $state
  & $node --input-type=module -e 'import(process.argv[1]).then(m=>m.initializeFreeTelemetry())' $initUri
  CheckExit "Default telemetry initialization"

  # Move verified runtime into the ONLY live installation path.
  $old = $null
  if(Test-Path $install){
    $old = Join-Path $Workspace ("vibe-monitor-previous-"+[guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $install -Destination $old
  }
  try { Move-Item -LiteralPath $newPackage -Destination $install }
  catch {
    if($old -and (Test-Path $old)){Move-Item $old $install}
    throw
  }
  $stableVersion = (& $node $stableEntry --version | Out-String).Trim()
  if($stableVersion -notmatch [regex]::Escape($version)){throw "Single active runtime verification failed"}
  foreach($name in @("vibe-monitor-rc","vibe-monitor-qa")){
    if($cfg.mcpServers.PSObject.Properties.Name -contains $name){
      $cfg.mcpServers.PSObject.Properties.Remove($name)
    }
  }
  if($cfg.mcpServers.PSObject.Properties.Name -contains "vibe-monitor"){
    $cfg.mcpServers.'vibe-monitor' = $newMcp
  } else {
    $cfg.mcpServers | Add-Member -NotePropertyName 'vibe-monitor' -NotePropertyValue $newMcp
  }
  $text = $cfg | ConvertTo-Json -Depth 80
  [IO.File]::WriteAllText($configPath,$text,(New-Object Text.UTF8Encoding($false)))
  # Verify exactly one Vibe MCP entry, and the fixed RC executable.
  $verify = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $registered = @($verify.mcpServers.PSObject.Properties.Name | Where-Object { $_ -match '^vibe-monitor($|-)' })
  if($registered.Count -ne 1 -or $registered[0] -ne 'vibe-monitor'){
    Copy-Item -LiteralPath $configBackup -Destination $configPath -Force
    throw "Exactly-one MCP verification failed"
  }

  # After successful replacement, delete only known obsolete Vibe QA versions.
  $obsolete = @(
    "vibe-022-win-realqa-20261018",
    "vibe-fixed-policy-qa-20261017",
    "vibe-free-pr74-test-20261016",
    "vibe-qa-20261015",
    "vibe-rc-native-qa-20261017",
    "vm-1.0.1-rc-qa",
    "vmqa-b14-20261016",
    "vibe-rc-win-antigravity-20261018",
    "vibe-rc-win-antigravity-isolated-20261018"
  )
  $removed = @()
  foreach($name in $obsolete){
    $target = Join-Path $Workspace $name
    if(Test-Path -LiteralPath $target){
      Remove-Item -LiteralPath $target -Recurse -Force
      $removed += $name
    }
  }
  # Also clean previous-version backup left by an earlier interrupted run.
  $leftover = @(Get-ChildItem -LiteralPath $Workspace -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^vibe-monitor-previous-[0-9a-f]{32}
  $launcherDir = Join-Path $state "bin"
  New-Item -ItemType Directory -Force $launcherDir | Out-Null
  $launcher = Join-Path $launcherDir "vibe-monitor.cmd"
  $launcherText = '@echo off' + "`r`n" + '"' + $node + '" "' + $stableEntry + '" %*' + "`r`n"
  [IO.File]::WriteAllText($launcher,$launcherText,(New-Object Text.ASCIIEncoding))
  # Keep the .vibe-monitor state directory, including identity and telemetry.
  # Remove only prior managed code installs, never the user's data directory.
  foreach($sub in @("runtime\versions","runtime\packages")){
    $target = Join-Path $state $sub
    if(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Recurse -Force}
  }
  Write-Output "SINGLE_VERSION_READY: $version"
  Write-Output "INSTALL=$install"
  Write-Output "ANTIGRAVITY_MCP=vibe-monitor"
  Write-Output ("OLD_QA_DIRECTORIES_REMOVED="+$removed.Count)
  Write-Output "Restart Antigravity to discard previously loaded MCP processes."
  $finished = $true
} finally {
  if(Test-Path $stage){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue}
  if(-not $finished){Write-Warning "Single-version setup did not complete. Inspect errors before deleting anything else."}
}
 })
  foreach($copy in $leftover) {
    Remove-Item -LiteralPath $copy.FullName -Recurse -Force
  }
  # Keep existing IDE launchers working, but route them to the same sole client.
  $launcherDir = Join-Path $state "bin"
  New-Item -ItemType Directory -Force $launcherDir | Out-Null
  $launcher = Join-Path $launcherDir "vibe-monitor.cmd"
  $launcherText = '@echo off' + "`r`n" + '"' + $node + '" "' + $stableEntry + '" %*' + "`r`n"
  [IO.File]::WriteAllText($launcher,$launcherText,(New-Object Text.ASCIIEncoding))
  # Keep the .vibe-monitor state directory, including identity and telemetry.
  # Remove only prior managed code installs, never the user's data directory.
  foreach($sub in @("runtime\versions","runtime\packages")){
    $target = Join-Path $state $sub
    if(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Recurse -Force}
  }
  Write-Output "SINGLE_VERSION_READY: $version"
  Write-Output "INSTALL=$install"
  Write-Output "ANTIGRAVITY_MCP=vibe-monitor"
  Write-Output ("OLD_QA_DIRECTORIES_REMOVED="+$removed.Count)
  Write-Output "Restart Antigravity to discard previously loaded MCP processes."
  $finished = $true
} finally {
  if(Test-Path $stage){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue}
  if(-not $finished){Write-Warning "Single-version setup did not complete. Inspect errors before deleting anything else."}
}
