<#
  humanchat-web.ps1 — 前台启动 HumanChat Web 界面（Ctrl+C 停止，不留后台进程）

  用法：  .\humanchat-web.ps1                          # 默认会话 human-in-the-loop
          .\humanchat-web.ps1 -Session deploy
          .\humanchat-web.ps1 -Port 9000
          .\humanchat-web.ps1 -Bind 0.0.0.0            # 手机/局域网（自动生成令牌）

  行为：broker 作为子进程跟本窗口同生共死；Web 服务前台运行；Ctrl+C 全部停掉。
        已经跑着 broker 时只复用、退出时不动它。
        默认每次都是全新会话（历史与未读队列在启动时清空）；想保留历史用 -Keep。
#>
param(
  [string]$Session = 'human-in-the-loop',
  [int]$Port = 8792,
  [string]$Bind = '127.0.0.1',
  [switch]$NoOpen,
  [switch]$Keep,        # 保留上次的历史（默认是每次全新）
  [string[]]$Extra = @()
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $here "humanchat_mcp.py"
if (-not (Test-Path $entry)) { throw "找不到 $entry" }
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { throw "找不到 python，请安装 Python 3.8+ 或加入 PATH" }

function Get-BrokerProc {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*humanchat_mcp.py*--broker*" }
}

function Test-BrokerUp {
  try {
    $out = & $py $entry status 2>$null
    foreach ($line in $out) { if ($line -match "pid=") { return $true } }
  } catch { }
  return $false
}

$ownPid = 0
if (@(Get-BrokerProc).Count -gt 0) {
  Write-Host "broker    : 复用已运行的实例（退出时不会动它）" -ForegroundColor DarkGray
} else {
  $logFile = Join-Path $env:TEMP "humanchat-broker.log"
  $broker = Start-Process -FilePath $py -PassThru -NoNewWindow -ArgumentList @($entry, "--broker") -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
  $ownPid = $broker.Id
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-BrokerUp) { $ready = $true; break }
  }
  if ($ready) {
    Write-Host "broker    : 已启动（pid $ownPid，随本窗口一起停止）" -ForegroundColor DarkGray
  } else {
    Write-Host "broker    : 启动失败，请看 $logFile" -ForegroundColor Red
  }
}

Write-Host "web 界面  : http://${Bind}:$Port/" -ForegroundColor Cyan
$freshNote = if ($Keep) { "（保留历史）" } else { "（全新会话：历史已清空）" }
Write-Host "会话      : $Session   （Ctrl+C 停止全部）$freshNote" -ForegroundColor Cyan
Write-Host ""

$webArgs = @($entry, "web", "--session", $Session, "--host", $Bind, "--port", "$Port")
if ($NoOpen) { $webArgs += "--no-open" } else { $webArgs += "--open" }
# 默认每次全新：清掉该会话的历史与未读队列；想留用 -Keep
if (-not $Keep) { $webArgs += "--fresh" }
if ($Extra.Count -gt 0) { $webArgs += $Extra }

$code = 0
try {
  & $py @webArgs
  $code = $LASTEXITCODE
} finally {
  if ($ownPid -gt 0) {
    Write-Host ""
    Write-Host "正在停止 broker (pid $ownPid) ..." -ForegroundColor DarkGray
    foreach ($p in @(Get-BrokerProc)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "已停止，无后台残留。" -ForegroundColor DarkGray
  } else {
    Write-Host "Web 界面已停止（broker 是复用的，继续运行）。" -ForegroundColor DarkGray
  }
}
exit $code
