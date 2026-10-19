# Cleanup ONLY: no clone, npm, test, build, or install.
[CmdletBinding()]
param([string]$Workspace = "$env:USERPROFILE\mcp-workspace",[switch]$SelfTest)
$ErrorActionPreference="Stop"
function Remove-DeepDirectory([string]$path) {
  if(-not(Test-Path -LiteralPath $path -PathType Container)){return $false}
  $full=[System.IO.Path]::GetFullPath($path)
  if(-not [System.IO.Path]::IsPathRooted($full)){throw "Unsafe delete path"}
  $extended='\\?\' + $full
  try {
    [System.IO.Directory]::Delete($extended,$true)
  } catch {
    $firstError=$_.Exception.Message
    $cmdLine='rd /s /q "{0}"' -f $extended
    & $env:ComSpec /d /s /c $cmdLine 2>$null | Out-Null
    if(Test-Path -LiteralPath $path){throw ("Cannot delete {0}: {1}" -f $path,$firstError)}
  }
  if(Test-Path -LiteralPath $path){throw "Directory remains: $path"}
  return $true
}
if($SelfTest){
  $base=Join-Path $env:TEMP ("vm-longpath-qa-"+[guid]::NewGuid().ToString("N"))
  try {
    $deep=$base
    for($i=0;$i -lt 12;$i++){
      $deep=Join-Path $deep ('nested_node_modules_{0}_abcdefghijklmnopqrstuvwxyz' -f $i)
      [System.IO.Directory]::CreateDirectory(('\\?\'+$deep)) | Out-Null
    }
    [System.IO.File]::WriteAllText(('\\?\'+(Join-Path $deep 'example.d.ts.map')),'fixture')
    if(-not (Remove-DeepDirectory $base)){throw 'Selftest removal failed'}
    Write-Output 'WINDOWS_LONG_PATH_CLEANUP_PASS'
  } finally {
    if(Test-Path -LiteralPath $base){Remove-DeepDirectory $base | Out-Null}
  }
  exit 0
}
$entry=Join-Path $Workspace 'vibe-monitor\node_modules\@vibe-monitor\setup\dist\vibe-monitor.mjs'
if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw "Active Vibe Monitor entry not found; refusing cleanup."}
$node=(Get-Command node.exe -ErrorAction Stop).Source
$version=(& $node $entry --version | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $version -notmatch '1\.0\.1-rc\.0'){throw "Active version mismatch ($version); refusing cleanup."}
$configPath=Join-Path $env:USERPROFILE '.gemini\config\mcp_config.json'
if(-not(Test-Path -LiteralPath $configPath)){throw "Antigravity MCP config absent; refusing cleanup."}
$cfg=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if(-not $cfg.mcpServers){throw "MCP config invalid; refusing cleanup."}
$names=@($cfg.mcpServers.PSObject.Properties.Name | Where-Object {$_ -match '^vibe-monitor($|-)'})
if($names.Count -ne 1 -or $names[0] -ne 'vibe-monitor'){throw "Duplicate/missing MCP entries: $($names -join ','); refusing cleanup."}
if(@($cfg.mcpServers.'vibe-monitor'.args)[0] -ne $entry){throw "MCP entry points to another runtime; refusing cleanup."}
Write-Output "ACTIVE_RC_VERIFIED: $version"
Write-Output 'ANTIGRAVITY_MCP_VERIFIED: vibe-monitor'

$state=Join-Path $env:USERPROFILE '.vibe-monitor'
$bin=Join-Path $state 'bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$launcher='@echo off' + [Environment]::NewLine + ('"{0}" "{1}" %*' -f $node,$entry) + [Environment]::NewLine
[System.IO.File]::WriteAllText((Join-Path $bin 'vibe-monitor.cmd'),$launcher,(New-Object System.Text.ASCIIEncoding))
$obsolete=@('vibe-022-win-realqa-20261018','vibe-fixed-policy-qa-20261017','vibe-free-pr74-test-20261016','vibe-qa-20261015','vibe-rc-native-qa-20261017','vm-1.0.1-rc-qa','vmqa-b14-20261016','vibe-rc-win-antigravity-20261018','vibe-rc-win-antigravity-isolated-20261018')
$targets=@($obsolete | ForEach-Object {Join-Path $Workspace $_})
$targets+=@(Get-ChildItem -LiteralPath $Workspace -Directory -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '^vibe-monitor-previous-[0-9a-f]{32}$'} | ForEach-Object {$_.FullName})
$targets+=@((Join-Path $state 'runtime\versions'),(Join-Path $state 'runtime\packages'))
$removed=0
$failed=@()
foreach($target in $targets){
  if(-not(Test-Path -LiteralPath $target)){continue}
  try{
    if(Remove-DeepDirectory $target){
      Write-Output ("REMOVED: "+$target)
      $removed++
    }
  } catch{
    $failed+=@($target)
    Write-Warning ("FAILED: "+$target+" - "+$_.Exception.Message)
  }
}
Write-Output ("REMOVED_COUNT="+$removed)
Write-Output ("FAILED_COUNT="+$failed.Count)
if($failed.Count -gt 0){throw "Cleanup incomplete: $($failed.Count) directories remain"}
Write-Output 'SINGLE_VERSION_CLEANUP_PASS'
