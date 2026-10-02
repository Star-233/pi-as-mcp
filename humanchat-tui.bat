@echo off
rem ================================================================
rem  双击这个文件 = 打开 HumanChat 人类终端（你就是在这个窗口里输入问题）
rem  高级用法：在 cmd 里执行  humanchat-tui.bat --simple
rem            --simple = 逐行模式（全屏界面兼容性差时使用）
rem ================================================================
chcp 65001 >nul 2>&1
setlocal
title humanchat launcher

rem ---- 1) 找到 python（优先 miniconda，其次标准安装，最后 PATH）----
set "PY="
if exist "D:\Program Files\miniconda3\python.exe" set "PY=D:\Program Files\miniconda3\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set "PY=%%i"
if not defined PY (
  echo [humanchat] 找不到 python，请安装 Python 3.8+ 或加入 PATH。
  pause
  exit /b 2
)

set "ENTRY=%~dp0humanchat_mcp.py"
if not exist "%ENTRY%" (
  echo [humanchat] 找不到 "%ENTRY%"
  echo 请把这个 bat 放在 humanchat-mcp 目录里。
  pause
  exit /b 2
)

rem ---- 2) 确保有一个常驻 broker（已存在就跳过，不会起第二个）----
"%PY%" "%ENTRY%" --broker --daemon

set "ARGS="
if /i "%~1"=="--simple" set "ARGS=--simple"

rem ---- 3) 打开人类终端窗口 ----
rem  整条命令整体加引号交给 start，斜杠参数 /max 必须放在引号外面，
rem  否则路径里的空格会把命令拆坏（D:\Program" "Files\... 那个经典坑）。
rem  会话名必须和 AgentDock 里注册的 --session 一致，否则人和 Agent 不在同一个会话。
start "humanchat" /max cmd /k ""%PY%" "%ENTRY%" attach --session human-in-the-loop %ARGS%"

rem ---- 4) 本窗口 2 秒后自动关闭，只留下终端界面 ----
timeout /t 2 /nobreak >nul 2>&1
endlocal
