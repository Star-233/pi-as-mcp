# Changelog

本项目的所有重要变更都会记在这里。版本号遵循 `MAJOR.MINOR.PATCH`。

## 1.1.0 — 浏览器界面（Web UI）

给人类侧新增了一套**零依赖**的浏览器界面，和原来的终端界面（TUI）同源、可并存。

### 新增

* `humanchat web` 子命令：本地 HTTP 服务 + Server-Sent Events，默认 `http://127.0.0.1:8792`，
  自动打开浏览器。端口被占用会自动往后找。
* 新模块：
  * `src/humanchat/webui.py` —— HTTP/SSE 服务端、broker 长连接、断线自愈、令牌鉴权；
  * `src/humanchat/webui_assets.py` —— 前端 HTML/CSS/JS（全部内联，无任何外链/CDN）。
* Web 界面功能：会话列表（搜索 / 未读徽标 / 等待指示 / 未消费消息角标）、Markdown 渲染
  （标题、列表、表格、行内代码、代码块 + 一键复制、链接）、`kind` 徽标与日期分隔、
  `🔔 正在等待你的回复 (mm:ss)` 实时计时、提示音 + 桌面通知、标签页未读计数、
  深色/浅色主题、输入历史、`/` 命令（`/help /new /rename /switch /clear /export /status
  /rules /search /sound /theme`）、对话内搜索高亮、导出 Markdown、窄屏（手机）适配。
* `HUMANCHAT_UI=tui|web`：控制 Agent 自动拉起哪一种人类界面，也决定 `attach_command`
  提示给人类的命令（`--ui` 命令行参数等效）。配 `web` 时不再需要任何终端模拟器。
* Windows 双击启动脚本：`humanchat-web.bat`、`humanchat-web.ps1`。
* `humanchat-web` 控制台入口（`pip install` 后可用）。
* 新的环境变量：`HUMANCHAT_WEB_HOST` / `HUMANCHAT_WEB_PORT` / `HUMANCHAT_WEB_TOKEN` /
  `HUMANCHAT_WEB_OPEN`。
* 新文档：`docs/web-ui.md`（用法、HTTP/SSE 接口、安全、排查），
  以及 `docs/web-ui-preview.html`（自带假数据、可离线打开的界面快照）。
* 新测试：`tests/test_webui.py`（18 个：页面无外链、`/api/*` 全链路、SSE 推送、
  令牌三种传法、**杀掉 broker 后自动重连并恢复收发**、重复启动复用同一实例、
  `HUMANCHAT_UI=web` 的命令拼装）。

### 改进

* `BrokerClient` 在连接断开时**立刻**让所有在飞的请求失败，并按 `code=disconnected` 上报；
  以前它们会各自干等到超时（表现为界面卡住、请求超时）。
* Web 服务器维护一个 `$HUMANCHAT_HOME/web.json`（端口 / 令牌 / pid），
  二次启动会复用已有实例而不是再起一个，避免两个界面各说各话。
* 监听非本机地址时自动生成访问令牌，并打印带 `?token=` 的地址；
  令牌支持 `?token=`、`Cookie`、`Authorization: Bearer` 三种传法。
* 启动横幅同时写入日志文件（用 `Start-Process -WindowStyle Hidden` 之类方式启动时看不到
  标准输出，也能从 `logs/broker.log` 里找到地址与令牌）。
* 测试：`tests/test_tui_pty.py` 把 `import pty` 改成软失败（Windows 上
  `unittest discover` 不再因为缺 `termios` 而整体报错）；
  `tests/test_sdk_compat.py` 为每个用例隔离 broker 端口（Windows 无 `AF_UNIX` 时
  broker 走 TCP，默认端口是“一台机器一个”，不隔离会互相抢）。
* 文档里“人类终端”的说法统一改为“人类界面（终端 TUI / 浏览器 Web）”。

### 兼容性

* MCP 侧（4 个工具、强制规则文本、keepalive 语义、stdio 与 streamable HTTP 传输）**没有行为变更**；
  Agent 侧不需要任何改动。Web 界面只是多了一个 `role=human` 的 broker 客户端。
* TUI 与逐行模式完全保留，命令与快捷键不变；两者可以同时开着，消息实时同步。

## 1.0.0 — 初始版本

* 零依赖 MCP 服务器（stdio / streamable HTTP）：`human_notify` / `human_wait` /
  `human_status` / `human_rules`。
* 服务端无限等待 + keepalive 分段返回（配合 AgentDock 的 300s 单次调用上限）。
* broker（UDS / TCP，NDJSON）：会话、消息落盘、未消费语义、多个人类客户端。
* 人类终端界面：全屏 TUI、逐行模式、自动拉起终端、子命令 `attach / send / status /
  quit-broker`。
