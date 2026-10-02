@echo off
rem ================================================================
rem  双击 = 前台启动 HumanChat Web 界面（Ctrl+C 停止，不留后台进程）
rem
rem  高级用法（在 cmd 里执行）：
rem    humanchat-web.bat --port 9000       指定端口
rem    humanchat-web.bat --host 0.0.0.0    手机 / 局域网访问（自动生成令牌）
rem    humanchat-web.bat --no-open         只起服务，不开浏览器
rem    humanchat-web.bat --session deploy  指定会话
rem
rem  会话名默认 human-in-the-loop，要和 AgentDock 注册 MCP 时的 --session 一致。
rem ================================================================
chcp 65001 >nul 2>&1
setlocal
title humanchat web

rem  交给 humanchat-web.ps1（前台运行；Ctrl+C 会同时停掉 broker 和 Web 服务）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0humanchat-web.ps1" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [humanchat] 退出，代码 %CODE%。
  pause
)
endlocal & exit /b %CODE%
