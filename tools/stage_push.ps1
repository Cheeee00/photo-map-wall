# 把工作区推到 GitHub（Cheeee00/photo-map-wall，公开库）
# 用法：& [scriptblock]::Create([IO.File]::ReadAllText('D:\DSH\创业项目\photo-map-wall\tools\stage_push.ps1')) -Push -Delete @('dist/index.html')
# 只删不传：把 -Push 换成 -DeleteOnly（gh_push 仍会重传这 87 个文件，幂等，不会造成 diff）
# 注意：-Delete 是 [string[]]，从命令行传必须写成 -Delete @('a','b')，只传一个字符串会被当文件名。
param(
  [string]$Repo = 'Cheeee00/photo-map-wall',
  # 用 [scriptblock]::Create(...) 调用时 $MyInvocation.MyCommand.Path 和 $PSScriptRoot 都是空的，给个兜底
  [string]$LocalDir = 'D:\DSH\创业项目\photo-map-wall',
  [string]$Message = 'update',
  [switch]$Push,
  # 只做删除同步（本地已删、GitHub 上还留着），不重新上传
  [switch]$DeleteOnly,
  [string]$Branch = 'main',
  # 本地已删、GitHub 上还留着的文件（比如被新测试取代的旧脚本）
  [string[]]$Delete = @()
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
# -File 是 pwsh 6+ 的参数，本机是 PowerShell 5.1 → 用 Test-Path -PathType Leaf 过滤
Get-ChildItem -Path $LocalDir -Recurse | Where-Object { Test-Path -LiteralPath $_.FullName -PathType Leaf } | ForEach-Object {
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
  & $sb -Repo $Repo -LocalDir $stage -Message $Message -Branch $Branch -Proxy 'http://127.0.0.1:7897' -Delete $Delete
}

if ($DeleteOnly) {
  $sp = 'C:\Users\ChenLong\.dsh\scripts\gh_push.ps1'
  if (-not (Test-Path $sp)) { throw "找不到 gh_push.ps1：$sp" }
  $sb = [scriptblock]::Create([IO.File]::ReadAllText($sp))
  & $sb -Repo $Repo -LocalDir $stage -Message $Message -Branch $Branch -Proxy 'http://127.0.0.1:7897' -Delete $Delete
}
