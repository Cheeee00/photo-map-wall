# 把工作区推到 GitHub（Cheeee00/photo-map-wall，公开库）
# 用法：& [scriptblock]::Create([IO.File]::ReadAllText((Join-Path (Split-Path $MyInvocation.MyCommand.Path) 'stage_push.ps1'))) -Push
param(
  [string]$Repo = 'Cheeee00/photo-map-wall',
  # 用 [scriptblock]::Create(...) 调用时 $MyInvocation.MyCommand.Path 和 $PSScriptRoot 都是空的，给个兜底
  [string]$LocalDir = 'D:\DSH\创业项目\photo-map-wall',
  [string]$Message = 'update',
  [switch]$Push,
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'

# 顶层目录：直接整体跳过
$skipTop = @('.wrangler', 'dist', '.git')
# 子目录：按前缀跳过（test/shots、test/_tmp）
$skipSub = @('test\shots', 'test\_tmp')

$stage = Join-Path $env:TEMP 'pmpush'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$n = 0
$bytes = 0
Get-ChildItem -Path $LocalDir -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($LocalDir.Length).TrimStart('\')
  $skip = $false
  foreach ($p in $skipTop) { if ($rel -eq $p -or $rel.StartsWith($p + '\')) { $skip = $true; break } }
  if (-not $skip) {
    foreach ($p in $skipSub) { if ($rel -eq $p -or $rel.StartsWith($p + '\')) { $skip = $true; break } }
  }
  if ($skip) { return }
  $dst = Join-Path $stage $rel
  $dir = Split-Path $dst -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  # functions/api/wall/[[path]].js 里有方括号，Copy-Item 默认当通配符 → 必须用 -LiteralPath
  Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
  $n++
  $bytes += $_.Length
}

"staged: $n files / $($bytes) bytes -> $stage"

if ($Push) {
  $sp = 'C:\Users\ChenLong\.dsh\scripts\gh_push.ps1'
  if (-not (Test-Path $sp)) { throw "找不到 gh_push.ps1：$sp" }
  $sb = [scriptblock]::Create([IO.File]::ReadAllText($sp))
  & $sb -Repo $Repo -LocalDir $stage -Message $Message -Branch $Branch -Proxy 'http://127.0.0.1:7897'
}
