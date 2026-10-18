# Windows PowerShell 5.1; requires Git, Node.js, npm. Does not touch Beta.41.
[CmdletBinding()]
param([string]$Workspace="$env:USERPROFILE\mcp-workspace",[switch]$SkipAntigravityConfig)
$ErrorActionPreference="Stop"
$baseCommit="fbf260c"
$source=Join-Path $Workspace "vibe-rc-win-antigravity-20261018"
$qa=Join-Path $Workspace "vibe-rc-win-antigravity-isolated-20261018"
function CheckExit([string]$what){if($LASTEXITCODE -ne 0){throw "$what failed: $LASTEXITCODE"}}
New-Item -ItemType Directory -Force $Workspace | Out-Null
if(-not(Test-Path $source)){
  git clone --depth 5 --branch fix/rc-prod-precision-20261018 https://github.com/tubban1/vibe-monitor.git $source
  CheckExit "Git clone"
}
if(-not(Test-Path (Join-Path $source ".git"))){throw "Existing test path is not a Git checkout; won't overwrite"}
git -C $source merge-base --is-ancestor $baseCommit HEAD
CheckExit "Verified RC ancestor"
$changes=@(git -C $source diff --name-only $baseCommit HEAD | Where-Object { $_ -and ($_ -notmatch '^scripts/qa-windows-antigravity-') })
if($changes.Count){throw "Unexpected changes beyond QA scripts: $($changes -join ',')"}
$dirty=@(git -C $source status --porcelain)
if($dirty.Count){throw "QA source dirty; refusing overwrite"}
Set-Location $source
npm.cmd ci --no-audit --no-fund; CheckExit "npm ci"
npm.cmd test; CheckExit "npm test"
npm.cmd run build; CheckExit "npm build"
foreach($name in @("artifacts","installed","ag-home","ag-appdata","ag-localappdata","ag-state","reports","synthetic-project")){
  New-Item -ItemType Directory -Force (Join-Path $qa $name) | Out-Null
}
npm.cmd pack --pack-destination (Join-Path $qa "artifacts"); CheckExit "npm pack"
$tar=Join-Path $qa "artifacts\vibe-monitor-setup-1.0.1-rc.0.tgz"
if(-not(Test-Path $tar)){throw "RC package archive missing"}
npm.cmd install --prefix (Join-Path $qa "installed") --no-audit --no-fund $tar; CheckExit "Isolated npm install"
$installed=Join-Path $qa "installed\node_modules\@vibe-monitor\setup"
$version=(Get-Content (Join-Path $installed "package.json") -Raw | ConvertFrom-Json).version
if($version -ne "1.0.1-rc.0"){throw "Wrong installed version"}
$entry=Join-Path $installed "dist\vibe-monitor.mjs"
$node=(Get-Command node.exe -ErrorAction Stop).Source
& $node $entry --version; CheckExit "RC executable"
& $node (Join-Path $source "scripts\qa-windows-antigravity-mcp.mjs") $entry $qa
CheckExit "Antigravity MCP acceptance"
if(-not $SkipAntigravityConfig){
  $p=Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"
  if(-not(Test-Path $p)){throw "Antigravity config not found, manual configuration needed"}
  $config=Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
  if(-not $config.mcpServers){throw "Unexpected Antigravity MCP config"}
  $old=$config.mcpServers.'vibe-monitor-rc'
  $envs=@{}
  if($old -and $old.env){foreach($kv in $old.env.PSObject.Properties){$envs[$kv.Name]=[string]$kv.Value}}
  $envs["HOME"]=Join-Path $qa "ag-home"
  $envs["USERPROFILE"]=Join-Path $qa "ag-home"
  $envs["APPDATA"]=Join-Path $qa "ag-appdata"
  $envs["LOCALAPPDATA"]=Join-Path $qa "ag-localappdata"
  $envs["VIBE_MONITOR_HOME"]=Join-Path $qa "ag-state"
  $envs["VIBE_MONITOR_SETUP_HOME"]=Join-Path $qa "ag-home"
  $rc=[pscustomobject]@{command=$node;args=@($entry,"mcp","--agent","antigravity");env=$envs}
  Copy-Item $p "$p.bak.qa-$(Get-Date -Format yyyyMMdd-HHmmss)"
  if($old){$config.mcpServers.'vibe-monitor-rc'=$rc}
  else{$config.mcpServers|Add-Member -NotePropertyName 'vibe-monitor-rc' -NotePropertyValue $rc}
  [IO.File]::WriteAllText($p,($config|ConvertTo-Json -Depth 64),(New-Object Text.UTF8Encoding($false)))
  Write-Host "RC entry updated; Beta.41/default MCP entries unchanged. Reload Antigravity MCP service."
}
Write-Host "WINDOWS_RC_READY: client 1.0.1-rc.0, base $baseCommit"
Write-Host "QA report: $(Join-Path $qa 'reports\mcp-results.json')"
