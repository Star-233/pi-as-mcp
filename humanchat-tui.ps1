# humanchat-tui.ps1 — 一键打开人类终端（TUI）
#   用法:  .\humanchat-tui.ps1                 # 默认会话 human-in-the-loop
#          .\humanchat-tui.ps1 -Session foo
param([string]$Session = 'human-in-the-loop')

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cand = Join-Path $here "humanchat_mcp.py"
if (-not (Test-Path $cand)) { throw "找不到 $cand" }
$py = (Get-Command python).Source

# 1) 确保有一个常驻 broker（已存在会自动跳过）
& $py $cand --broker --daemon

# 2) 打开一个真正的终端窗口
$tui = "cd /d `"$here`" && `"$py`" `"$cand`" attach --session $Session"
Write-Host "打开人类终端 ... 会话: $Session" -ForegroundColor Cyan
if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
  Start-Process wt.exe -ArgumentList @("new-tab", "--title", "humanchat", "cmd", "/k", $tui)
} else {
  Start-Process cmd.exe -ArgumentList @("/k", $tui)
}
