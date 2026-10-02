<#
  humanchat-adup.ps1 — 一条命令拉起 AgentDock + HumanChat Web 界面，
  并打印（并复制）一段可以直接发给别的 agent 的接入提示词。

  用法：  .\humanchat-adup.ps1                    # 默认会话 human-in-the-loop
          .\humanchat-adup.ps1 -Port 9000
          .\humanchat-adup.ps1 -NoOpen             # 不自动开浏览器
          .\humanchat-adup.ps1 -KeepAdock          # Ctrl+C 时保留 AgentDock
          .\humanchat-adup.ps1 -NoWeb              # 只起 AgentDock + 打印提示词
          .\humanchat-adup.ps1 -NoCopy             # 不写剪贴板

  行为：AgentDock 没在跑就先起（core + tunnel，等就绪）；打印状态与接入提示词并写入剪贴板；
        然后前台运行 HumanChat Web 界面（Ctrl+C 停）。若 AgentDock 是本脚本启动的，
        退出时一并停掉（-KeepAdock 可保留）；如果本来就是复用的，退出时不动它。
#>
param(
  [string]$Session = 'human-in-the-loop',
  [int]$Port = 8792,
  [string]$Bind = '0.0.0.0',
  [switch]$Keep,
  [switch]$NoOpen,
  [switch]$KeepAdock,
  [switch]$NoCopy,
  [switch]$NoWeb
)
# --- 自动升到 PowerShell 7 ---------------------------------------------------
# Windows PowerShell 5.1 会把「UTF-8 无 BOM」的文件按 ANSI(GBK) 解码，中文全乱。
# 这里检测到 5.1 就把自己交给 pwsh 7 重新执行（参数原样转发）。
if ($PSVersionTable.PSVersion.Major -lt 7) {
  $pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if ($pwshExe) {
    Write-Host '  [兼容] 当前是 Windows PowerShell，自动改用 PowerShell 7 重新运行 ...' -ForegroundColor DarkGray
    & $pwshExe -NoProfile -File $PSCommandPath @PSBoundParameters
    exit $LASTEXITCODE
  }
}
# ----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$webScript = Join-Path $here 'humanchat-web.ps1'
$promptFile = Join-Path $here 'docs\agent-handoff-prompt.md'
$PS = 'powershell'
if (Get-Command pwsh -ErrorAction SilentlyContinue) { $PS = 'pwsh' }

$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'AgentDock'
$AdockHome = Join-Path $env:USERPROFILE '.agentdock'
$AdPort = 8765
$RuntimeJson = Join-Path $RuntimeRoot 'runtime.json'
if (Test-Path $RuntimeJson) {
  try {
    $rj = Get-Content $RuntimeJson -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($rj.install_root) { $RuntimeRoot = [string]$rj.install_root }
    if ($rj.agentdock_home) { $AdockHome = [string]$rj.agentdock_home }
    if ($rj.port) { $AdPort = [int]$rj.port }
  } catch { }
}
$Exe = Join-Path $RuntimeRoot 'bin\agentdock.exe'
$AdockPs1 = Join-Path $AdockHome 'adock.ps1'
$AccessFile = Join-Path $AdockHome 'adock-access.json'
$ServersFile = Join-Path $AdockHome 'mcp\servers.json'
$LocalMcp = 'http://127.0.0.1:' + $AdPort + '/mcp'

function Test-Core {
  try {
    $r = Invoke-WebRequest ('http://127.0.0.1:' + $AdPort + '/healthz') -TimeoutSec 5 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}
function Get-AdJson {
  param([string[]]$AdArgs)
  if (-not (Test-Path $Exe)) { return $null }
  try {
    $raw = (& $Exe @AdArgs 2>&1 | Out-String).Trim()
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}
function Write-Row {
  param([string]$Label, [string]$Value, [string]$Color = 'Gray')
  Write-Host ('  ' + $Label.PadRight(11)) -NoNewline -ForegroundColor DarkGray
  Write-Host $Value -ForegroundColor $Color
}

Write-Host ''
Write-Host '  ══════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '   AgentDock + HumanChat 一体化启动' -ForegroundColor Cyan
Write-Host '  ══════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''

$ownAdock = $false
if (Test-Core) {
  Write-Host '  AgentDock : 已在运行（复用；退出时不会动它）' -ForegroundColor DarkGray
} elseif (Test-Path $AdockPs1) {
  Write-Host '  AgentDock : 未运行，正在启动 core + tunnel ...' -ForegroundColor Yellow
  & $PS -NoProfile -ExecutionPolicy Bypass -File $AdockPs1 up -Detach | Out-Host
  $ownAdock = $true
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Core) { break }
    Start-Sleep -Milliseconds 700
  }
} else {
  Write-Host ('  AgentDock : 找不到 ' + $AdockPs1 + '（跳过，只起界面）') -ForegroundColor DarkYellow
}

$svc = Get-AdJson @('service', 'status', '--runtime-root', $RuntimeRoot)
$tun = Get-AdJson @('tunnel', 'status', '--runtime-root', $RuntimeRoot)
$acc = $null
# 注意：adock-access.json 是 UTF-8 无 BOM 且 note 含中文，必须显式 -Encoding UTF8；
# 否则 PowerShell 5.1 按 ANSI 读，中文被截断导致 ConvertFrom-Json 解析失败、Bearer 读不到。
if (Test-Path $AccessFile) { try { $acc = Get-Content $AccessFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
$token = ''
if ($acc) { $token = [string]$acc.bearer_token }
$public = ''
if ($tun -and $tun.public_url) { $public = [string]$tun.public_url + '/mcp' }

$regSession = ''
if (Test-Path $ServersFile) {
  try {
    $all = @((Get-Content $ServersFile -Raw -Encoding UTF8 | ConvertFrom-Json).servers)
    $hc = $all | Where-Object { [string]$_.name -eq 'humanchat' } | Select-Object -First 1
    if ($hc -and $hc.args) {
      $idx = [Array]::IndexOf($hc.args, '--session')
      if ($idx -ge 0 -and ($idx + 1) -lt $hc.args.Count) { $regSession = [string]$hc.args[$idx + 1] }
    }
    $names = ($all | ForEach-Object { [string]$_.name + '(' + [string]$_.transport + ')' }) -join ', '
  } catch { }
}

Write-Host ''
$coreState = 'stopped'
if ($svc -and $svc.running) { $coreState = 'running' }
$tunState = 'stopped'
if ($tun -and $tun.running) { $tunState = 'running' }
Write-Row 'AgentDock' ('core=' + $coreState + '  tunnel=' + $tunState + '  healthy=' + (Test-Core)) 'White'
Write-Row '本地 MCP' $LocalMcp 'White'
if ($public) { Write-Row '公网 MCP' $public 'Green' } else { Write-Row '公网 MCP' '(隧道未就绪)' 'DarkYellow' }
if ($token) { Write-Row 'Bearer' $token 'Yellow' } else { Write-Row 'Bearer' '(未记录，用 adcreds 查)' 'DarkYellow' }
if ($names) { Write-Row '上游 MCP' $names 'Green' }
Write-Row '会话' $Session 'White'

if ($regSession -and $regSession -ne $Session) {
  Write-Host ''
  Write-Host ('  ! 注意：AgentDock 里 humanchat 注册的会话是 "' + $regSession + '"，') -ForegroundColor Red
  Write-Host ('    而本脚本用的是 "' + $Session + '" —— 两边不一致会互相看不见。') -ForegroundColor Red
}

$prompt = ''
if (Test-Path $promptFile) {
  $tpl = Get-Content $promptFile -Raw -Encoding UTF8
  $pubForPrompt = $public
  if (-not $pubForPrompt) { $pubForPrompt = '(隧道未就绪，先发本机地址)' }
  $prompt = $tpl.Replace('{{PUBLIC_MCP}}', $pubForPrompt)
  $prompt = $prompt.Replace('{{LOCAL_MCP}}', $LocalMcp)
  $prompt = $prompt.Replace('{{BEARER}}', $token)
  $prompt = $prompt.Replace('{{SESSION}}', $Session).Trim()
  Write-Host ''
  Write-Host '  ── 发给别的 agent 的接入提示词（整段复制）──────────────────' -ForegroundColor Cyan
  Write-Host ''
  foreach ($ln in ($prompt -split "\r?\n")) {
    if ($ln.Length -eq 0) { Write-Host '' } else { Write-Host ('    ' + $ln) -ForegroundColor Gray }
  }
  Write-Host ''
  Write-Host '  ──────────────────────────────────────────────────────────' -ForegroundColor Cyan
  if (-not $NoCopy) {
    try {
      Set-Clipboard -Value $prompt
      Write-Host '  ✔ 上面这段已复制到剪贴板，直接粘贴给对方 agent 即可。' -ForegroundColor Green
    } catch {
      Write-Host '  (剪贴板不可用，请手动选中复制)' -ForegroundColor DarkYellow
    }
  }
} else {
  Write-Host ('  ! 找不到提示词模板: ' + $promptFile) -ForegroundColor Red
}

Write-Host ''
Write-Host '  humanchat 界面的本机/局域网地址与访问令牌，见下方启动横幅。' -ForegroundColor DarkGray

if ($NoWeb) {
  Write-Host ''
  Write-Host '  (-NoWeb：未启动 humanchat 界面)' -ForegroundColor DarkGray
  Write-Host ''
  return
}

if (-not (Test-Path $webScript)) { throw ('找不到 ' + $webScript) }
Write-Host ''
Write-Host '  ── 启动 HumanChat Web 界面（Ctrl+C 停止）──────────────────' -ForegroundColor Cyan
Write-Host ''
$webArgs = @('-Session', $Session, '-Port', [string]$Port, '-Bind', $Bind)
if ($NoOpen) { $webArgs += '-NoOpen' }
if ($Keep) { $webArgs += '-Keep' }

try {
  & $PS -NoProfile -ExecutionPolicy Bypass -File $webScript @webArgs
} finally {
  if ($ownAdock) {
    if ($KeepAdock) {
      Write-Host '  AgentDock 保留运行（-KeepAdock）；要停用 addown。' -ForegroundColor DarkGray
    } else {
      Write-Host '  正在停止 AgentDock（本脚本启动的）...' -ForegroundColor DarkGray
      try { & $PS -NoProfile -ExecutionPolicy Bypass -File $AdockPs1 down | Out-Null } catch { }
      Write-Host '  已停止。' -ForegroundColor DarkGray
    }
  } else {
    Write-Host '  AgentDock 是复用的，继续运行。' -ForegroundColor DarkGray
  }
}
