# HumanChat MCP

> **让 Agent 干完活之后不要结束对话，而是停下来等人类说话。**
> 一个零依赖的 MCP 服务器（纯 Python 标准库）+ 两种人类界面（**终端 TUI** 与
> **浏览器 Web 界面**），可直接接入 [AgentDock](https://github.com/uvwt/agentdock)
> （`transport: stdio / streamable_http`）。

```
              ChatGPT / Claude / Codex / 任意 MCP 客户端
                              │
                              │ MCP（initialize → 强制规则；tools/call → 长等待）
                              ▼
                        AgentDock（可选）
                              │
                              ▼
        ┌────────────────  humanchat MCP 服务器  ────────────────┐
        │  human_notify  ·  human_wait  ·  human_status  ·  rules │
        │  无限等待 + keepalive 分段返回（永不超时、消息永不丢）    │
        └───────────────────────────┬────────────────────────────┘
                                    │ broker（Unix socket / TCP，NDJSON）
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
        人类界面 A：终端 TUI              人类界面 B：浏览器 Web
        humanchat attach                 humanchat web      ← 手机 / 平板也能接入
```
两个界面同源（都是 broker 的 `role=human` 客户端），可以同时开着，消息实时同步。

---

## 1. 它解决什么问题

| 常见痛点 | HumanChat 的做法 |
| --- | --- |
| Agent 干完任务就直接结束回合，人类想追问只能重新开一轮、重新贴上下文 | Agent 收尾时必须调用 `human_wait`，**停在原地等人类的下一个问题** |
| Agent 用客户端自带的 `ask_user / ask_question` 之类的内置提问工具，行为不可控 | 规则反复强调：**只允许用本 MCP 的 `human_notify / human_wait`** |
| 长等待会被客户端的单次调用超时打断（AgentDock 上限 **300 秒**） | **等待在服务端无限持续**，只按 `keepalive` 分段返回；Agent 收到 `keepalive` 立刻再调用一次，形成永不结束的循环 |
| 人类错过消息、Agent 重启导致消息丢失 | 消息落盘到 `~/.humanchat/sessions/*.jsonl`，**只有被消费才算送达**，重启后仍可取回 |
| 服务器 / 容器里没有图形界面 | 自动尝试 tmux 新窗口 / macOS Terminal / Linux 终端模拟器；失败则给出 `attach` 命令，Agent 会转告人类 |

---

## 2. 特性一览

**MCP 侧（Agent 看到的）**
- 4 个工具：`human_notify`、`human_wait`、`human_status`、`human_rules`
- `initialize.instructions`、每个工具的 description、**每一次工具返回内容**里都会重复强制规则（用户要求的“多次提醒”）
- 长等待期间按心跳发送 `notifications/progress` / `notifications/message`，连接不会被判死
- 支持 `notifications/cancelled` 取消；被取消/超时后消息仍然保留，下次 `human_wait` 立刻取回
- 资源（`humanchat://rules`、`humanchat://sessions`、`humanchat://transcript/latest`）与提示词（`human_handoff`）
- **零依赖**：`python3 humanchat_mcp.py` 即用，不需要 `pip install`（兼容 MCP 协议 2024-11-05 / 2025-03-26 / 2025-06-18）

**人类侧 · 终端 TUI**
- 全屏 TUI：消息滚动、多行输入、输入历史、会话切换、`/` 命令、等待计时器、声音/桌面通知
- 逐行模式（`--simple`）适配没有全屏能力的终端

**人类侧 · 浏览器 Web 界面（`humanchat web`）**
- 零依赖：只用标准库 `http.server` + SSE，页面资源全部内联，**不引 CDN、离线可用**
- 聊天式布局：Markdown 渲染（含代码块一键复制）、角色气泡、日期分隔、`kind` 徽标
- 侧栏会话列表：搜索、未读徽标、`Agent 正在等待` 的跳动指示、一键切换
- 状态胶囊实时显示 `🔔 正在等待你的回复 (mm:ss)`；Agent 开始等待 / 汇报完成时响铃 + 桌面通知
- 断线自愈：broker 重启（AgentDock 重启 stdio MCP）时页面出现横幅并自动恢复，**无需刷新**
- 手机 / 平板可用（窄屏抽屉式侧栏）；令牌保护（监听非本机地址时自动生成）
- 输入历史、`/` 命令、深色/浅色主题、会话内搜索、导出 Markdown
- `send / status / sessions / export / quit-broker` 等命令行子命令（可以脚本化、可以从别的终端发一句话）
- broker 断线（例如 AgentDock 重启）时**自动重连**，不用重新打开界面

**工程性**
- broker 可独立常驻（`--broker --daemon`），MCP 以客户端接入，人类界面不随 MCP 重启而中断
- 41 个测试（含 PTY 真终端、Web/SSE、断线重连、local/remote 双模式），并用官方 MCP Python SDK **v1.30 与 v2.2** 作为客户端交叉验证过 stdio 与 streamable HTTP

---

## 3. 快速开始（3 步）

```bash
# ① 放到机器上（无需安装依赖）
git clone <this-repo> ~/humanchat-mcp      # 或者直接拷贝目录
python3 ~/humanchat-mcp/humanchat_mcp.py --version
```

```bash
# ② 让 AgentDock（或任何 MCP 客户端）注册这个 MCP —— 见第 4 节
```

```bash
# ③ 人类打开界面（AgentDock 通常会自动帮你打开；也可以手动，二选一）
python3 ~/humanchat-mcp/humanchat_mcp.py attach   # 终端界面（TUI）
python3 ~/humanchat-mcp/humanchat_mcp.py web      # 浏览器界面（推荐，自动打开）
```

> 想让 Agent 自动打开的永远是**浏览器界面**：注册 MCP 时加环境变量 `HUMANCHAT_UI=web`
> （见第 4 节），之后人类界面、以及 Agent 转告人类的接入命令都会变成 `humanchat web`。

打开后你会看到：

```
 humanchat │ default │ 2 条消息                                    🔔 正在等待你的回复 (00:03)
────────────────────────────────────────────────────────────────────────────────────────
  ✅ Agent 17:44:32 · done
    ✅ 已完成部署：
    · 拉取镜像 agentdock:v0.9.1
    · 重启 3 个容器，健康检查通过
    · 回滚点：snapshot-20261003-1012

  🧑 你 17:44:37
    帮我确认一下 nginx 的配置有没有生效

────────────────────────────────────────────────────────────────────────────────────────
  说点什么…（Enter 发送 · Ctrl+J 换行 · F1 帮助）

 Enter 发送 · Ctrl+J 换行 · ↑↓ 滚动 · Tab 会话 · / 命令 · F1 帮助 · Ctrl+C 退出
```

---

## 4. 接入 AgentDock

AgentDock 通过 `mcp_manage` 注册外部 MCP，并且每个请求的超时上限是 **300000 ms**。

### 方式 A：stdio（最简单，推荐先用这个）

直接对 AgentDock 里的 Agent 说：

> 用 `mcp_manage` 注册一个本地 MCP 服务：
> `action=add`、`name=humanchat`、`description=人类在环终端对话`、`transport=stdio`、
> `command=python3`、`args=["/绝对路径/humanchat-mcp/humanchat_mcp.py"]`、`timeout_ms=300000`、`enabled=true`；
> 然后 `action=refresh`，并用 `mcp_tool_search` 搜索 `human` 确认能看到 4 个工具。

等价于 AgentDock 内部这样一条配置（`ServerConfig`）：

```json
{
  "name": "humanchat",
  "description": "人类在环对话：Agent 停止后等待人类提问",
  "transport": "stdio",
  "command": "python3",
  "args": ["/absolute/path/humanchat-mcp/humanchat_mcp.py", "--stdio"],
  "timeout_ms": 300000,
  "enabled": true,
  "env": {"HUMANCHAT_UI": "web"}
}
```

> 上面最后一行 `env` 是可选的：加上它，Agent 第一次需要人类界面时会自动打开
> **浏览器界面**（`humanchat web --open`），提示给人类的接入命令也是 `humanchat web`；
> 不加则默认打开终端 TUI。想显式传宿主机环境变量可以用 AgentDock 的 `env_from_env`，
> 例如 `{"HUMANCHAT_UI": "HUMANCHAT_UI", "HUMANCHAT_HOME": "HUMANCHAT_HOME"}`。

之后 Agent 通过 `mcp_tool_call` 调用，名字是带前缀的：

```json
{"name": "humanchat:human_wait", "arguments": {"keepalive_seconds": 240}}
```

### 方式 B：streamable HTTP

```bash
# 常驻启动 MCP HTTP 端点（默认 http://127.0.0.1:8791/mcp）
python3 humanchat_mcp.py --http --port 8791
```

```json
{
  "name": "humanchat",
  "transport": "streamable_http",
  "url": "http://127.0.0.1:8791/mcp",
  "timeout_ms": 300000,
  "enabled": true
}
```

HTTP 模式下长等待会返回 **SSE 流**：等待期间持续推 `notifications/progress` 心跳，
人类一说话就把最终响应写进同一个流里。

> 详细步骤（含 Docker、systemd 常驻、验证与排查）见 [`docs/agentdock-setup.md`](docs/agentdock-setup.md)。

### 给 Agent 的收尾指令（建议贴在对话开头或 AGENTS.md）

> 任务完成后**不要结束对话**：先 `human_notify(kind="done", then_wait=true)`，收到
> `status="keepalive"` 就**立刻再次调用** `human_wait`，无限循环，直到人类明确说结束。
> 任何情况都不要使用内置的 ask/question 工具。

可以直接复制 [`docs/agents-rules.md`](docs/agents-rules.md) 到 AgentDock 的
`AGENTS.md`（`workspace_context` 会加载）或客户端系统提示里。

---

## 5. 无限等待是怎么做到的

AgentDock 对一次 `mcp_tool_call` 有 **300s** 硬上限，任何“真的阻塞 10 小时”的调用都会被掐断。
HumanChat 的解法是 **服务端无限等待 + 分段返回**：

```
Agent: human_wait(keepalive_seconds=240)
        │
        ├── 0s ─────────────── 开始等待（服务端状态：waiting；人类终端显示"🔔 正在等待你的回复 00:00"）
        ├── 每 15s ─────────── 心跳：notifications/progress / notifications/message（连接保活）
        ├── 240s ───────────── 返回 status="keepalive"（这不是超时，是"该续一次了"）
        │                      → 指令：立刻再次调用 human_wait，参数不变
        ├── 人类说话 ───────── 立刻返回 status="human_message"（不用等到 240s）
        └── …重复…
```

关键保证：

1. **没有单次调用会超过客户端的超时上限**（默认 keepalive 240s < 300s）；
2. **等待的总时长没有上限**：只要 Agent 按指令继续调用，就一直等下去；
3. **人类消息永不丢失**：消息一旦落盘就处于“未消费”状态，任何一次 `human_wait`
   或 `human_status(include_backlog=true)` 都会把它取出来 —— 哪怕中途断线、重启、超时被取消；
4. 想要“字面意义上的永不返回”，把 `keepalive_seconds` 传 `0`（适用于没有单次调用上限的客户端，
   例如本地 CLI Agent 直连本 MCP）。

> 人类想结束：直接说“结束 / 不用了 / exit / bye”。规则里只有这种情况允许 Agent 停止循环。

---

## 6. 人类界面怎么用

```bash
# —— 浏览器界面（推荐；零依赖，页内无外链，手机也能连）——
python3 humanchat_mcp.py web                   # 起服务 + 自动打开浏览器（127.0.0.1:8792）
python3 humanchat_mcp.py web --port 9000 --no-open
python3 humanchat_mcp.py web --host 0.0.0.0    # 手机 / 局域网访问（自动生成令牌并打印地址）
```

Windows 上可以直接运行 `humanchat-web.ps1`（默认开启 `0.0.0.0` 局域网访问并自动生成令牌）——它会确保 broker
在跑、启动 Web 服务、打开浏览器；已经开着的话只是再开一个标签页。

界面要点：左侧会话列表（搜索 / 未读徽标 / 等待指示）、顶栏实时状态胶囊
`🔔 正在等待你的回复 (mm:ss)`、Markdown 消息（代码块可一键复制）、提示音 + 桌面通知、
Agent 等待时自动响铃、断线自动重连（broker 重启也不丢消息）、深色/浅色主题、
`/` 命令（`/new /rename /switch /clear /export /status /rules /search /sound /theme`）。
完整说明与 HTTP/SSE 接口见 [`docs/web-ui.md`](docs/web-ui.md)。

```bash
# —— 终端界面（TUI）——
python3 humanchat_mcp.py attach                # 全屏界面
python3 humanchat_mcp.py attach --simple       # 逐行模式（无全屏能力时）
python3 humanchat_mcp.py attach -s deploy      # 指定会话

# —— 其他子命令 ——
python3 humanchat_mcp.py send "继续"           # 不开界面，直接说一句
python3 humanchat_mcp.py status                # 查看通道/会话状态
python3 humanchat_mcp.py quit-broker           # 停止常驻 broker
```

| 快捷键 | 作用 |
| --- | --- |
| `Enter` | 发送 |
| `Ctrl+J` / `Alt+Enter` | 输入换行（多行消息） |
| `↑ ↓` / `PgUp` `PgDn` / `Home` `End` | 滚动消息 |
| `Tab` / `Shift+Tab` | 切换会话 |
| `Ctrl+P` / `Ctrl+N` | 输入历史 |
| `Ctrl+L` | 重绘 |
| `F1` / `?` | 帮助 |
| `Ctrl+C` | 退出（Agent 仍在服务端继续等待，消息不会丢） |

`/` 命令：`/help`、`/sessions`、`/switch <id>`、`/new [id]`、`/rename <标题>`、
`/clear`、`/export [路径]`、`/status`、`/rules`、`/quit`。

界面行为要点：
- Agent 开始等待时，状态条变成反色的 **🔔 正在等待你的回复 (mm:ss)**，并响铃；
- Agent 汇报 `done / question / error` 时会响铃（macOS 还会发系统通知）；
- 支持 **bracketed paste**：多行粘贴不会被逐行发送；
- 断开连接（例如 AgentDock 重启）时自动重连，界面不退出。

---

## 6.5 不用 AgentDock 也能先体验（两个终端）

```bash
# 终端 1：人类界面
python3 humanchat_mcp.py attach

# 终端 2：模拟一个守规矩的 Agent
python3 examples/demo_agent.py
```

终端 2 会模拟：汇报完成 → `human_wait` 循环（每 6 秒一次 keepalive，打印“这不是超时”）→
你在终端 1 说话 → 它立刻收到并回复 → 继续等待 → 你说“结束”它才停。

---

## 7. 部署形态

**形态 1：MCP 自带 broker（零配置）**
AgentDock 拉起 stdio MCP 时，broker 就在这个进程里；人类界面通过
`~/.humanchat/broker.sock` 接入。缺点：AgentDock 重启 MCP 时人类界面会短暂断开（会自动重连）。

**形态 2：常驻 broker（推荐长期使用）**

```bash
python3 humanchat_mcp.py --broker --daemon          # 后台常驻
```

之后无论 MCP 进程怎么重启，人类界面都不断线；MCP 启动时探测到已有 broker 会自动以
客户端身份接入（`broker 模式: remote`）。

systemd 示例（Linux/VPS）：

```ini
# ~/.config/systemd/user/humanchat.service
[Unit]
Description=HumanChat broker (human-in-the-loop terminal)
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/humanchat-mcp/humanchat_mcp.py --broker
Environment=HUMANCHAT_HOME=%h/.humanchat
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now humanchat
```

**Docker 里的 AgentDock**：把本项目挂进容器，注册 stdio MCP 时用容器内的
`python3 /opt/humanchat-mcp/humanchat_mcp.py`；人类侧用
`docker exec -it <container> python3 /opt/humanchat-mcp/humanchat_mcp.py attach`（或在宿主机跑
broker + 挂载同一个 `HUMANCHAT_HOME`）。

---

## 8. 强制规则是怎么“多次提醒” Agent 的

| 位置 | 内容 |
| --- | --- |
| `initialize.instructions` | 完整规则块（中英双语）+ 标准收尾流程 + keepalive 语义 |
| 每个工具的 `description` | 工具级警告：禁止内置提问工具、禁止结束对话、keepalive 必须继续 |
| 每次工具返回的文本尾部 | `━━ HUMANCHAT 强制提醒 ━━` 三条 + 本次的具体下一步动作 |
| `human_rules` 工具 | Agent 任何时候可自查规则（也方便人类让它复述） |
| MCP 资源 / 提示词 | `humanchat://rules`、`human_handoff` prompt（支持 prompt 的客户端可直接注入） |
| `docs/agents-rules.md` | 给 `AGENTS.md` / 系统提示用的纯文本版本 |

即使某个客户端不显示 `instructions`，Agent 也会在**每一次工具调用**看到规则和“下一步必须调用 human_wait”。

---

## 9. 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HUMANCHAT_HOME` | `~/.humanchat` | 状态目录（会话记录、socket、日志） |
| `HUMANCHAT_KEEPALIVE_SECONDS` | `240` | 分段返回间隔；`0` = 真正永久阻塞不返回 |
| `HUMANCHAT_HEARTBEAT_SECONDS` | `15` | 心跳（progress / log 通知）间隔 |
| `HUMANCHAT_AUTOLAUNCH` | `auto` | `auto` / `always` / `never`：是否自动打开人类终端 |
| `HUMANCHAT_LAUNCH_CMD` | — | 自定义拉起命令，`{}` 会被替换为 attach 命令 |
| `HUMANCHAT_SESSION` | `default` | 默认会话 id |
| `HUMANCHAT_SOCKET` | `$HOME/broker.sock` | 自定义 Unix socket 路径 |
| `HUMANCHAT_TCP` / `_TCP_HOST` / `_TCP_PORT` | off / 127.0.0.1 / 8790 | 用 TCP 代替 Unix socket（跨容器场景） |
| `HUMANCHAT_TOKEN` | — | 人类侧与 HTTP MCP 的共享令牌（`Authorization: Bearer`） |
| `HUMANCHAT_HTTP_HOST` / `_HTTP_PORT` | 127.0.0.1 / 8791 | `--http` 的监听地址与端口 |
| `HUMANCHAT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `HUMANCHAT_UI` | `tui` | 人类界面形态：`tui`（终端）或 `web`（浏览器）。决定 Agent 自动打开哪一种、以及提示给人类的接入命令 |
| `HUMANCHAT_WEB_HOST` | `127.0.0.1` | `web` 子命令的默认监听地址 |
| `HUMANCHAT_WEB_PORT` | `8792` | `web` 子命令的默认端口 |
| `HUMANCHAT_WEB_TOKEN` | 空 | Web 界面固定令牌（为空时：仅本机监听不启用；监听其它地址自动生成） |
| `HUMANCHAT_WEB_OPEN` | `auto` | `auto`（自动开浏览器）/ `never` |

在 AgentDock 里注册 stdio 时，可以用 `env_from_env` 把宿主环境变量透传给孩子进程，例如
`{"HUMANCHAT_HOME": "HUMANCHAT_HOME"}`。

---

## 10. 故障排查

| 现象 | 处理 |
| --- | --- |
| Agent 说看不到 humanchat 工具 | `mcp_manage action=refresh`；用 `mcp_tool_search` 搜 `human`；确认 `command`/`args` 是绝对路径、`python3` 可用 |
| 工具能调，但人类终端没弹出 | 无图形界面/容器里属正常。手动跑 `attach`（Agent 会在 `human_wait` 的返回里带上这条命令） |
| `human_wait` 返回 `cancelled` | 客户端单次调用超时（例如 AgentDock 的 300s）。把 `keepalive_seconds` 调到 240 以内，或在注册时设 `timeout_ms=300000` |
| 界面显示“与 broker 断开，正在重连…” | AgentDock 重启了 MCP；界面会自动重连（Web 界面会显示断线横幅，恢复后自动回到最新状态）。想彻底避免请用 `--broker --daemon` 常驻 |
| 浏览器打开是「需要一个访问令牌」 | 用终端里打印的带 `?token=` 的地址，或把 token 粘进页面输入框 |
| 手机打不开 Web 界面 | 需要 `web --host 0.0.0.0`，用打印的「局域网」地址（带 token），并放行防火墙端口 |
| `web` 报端口被占用 | 会自动往后找端口（看启动输出的实际地址）；也可 `--port` 指定；重复执行只会再开一个标签页 |
| 新起的界面接上了「别的」broker | 一台机器共用一个 broker（这是设计：人和 Agent 必须在同一个 broker 里）。Windows 上无 AF_UNIX 时 broker 走 `tcp://127.0.0.1:8790`，跨 `HUMANCHAT_HOME` 共享；需要隔离时设 `HUMANCHAT_TCP=1` + `HUMANCHAT_TCP_PORT=<空闲端口>` |
| 消息似乎“晚了”才收到 | 消息按未消费状态排队，下一次 `human_wait` / `human_status(include_backlog=true)` 会立刻取回；不会丢失 |
| 想看细节 | `HUMANCHAT_LOG_LEVEL=debug`，日志在 `$HUMANCHAT_HOME/logs/broker.log` |

---

## 11. 项目结构 & 测试

```
humanchat-mcp/
├── humanchat_mcp.py            # 单文件入口（AgentDock 注册就指向它；零依赖）
├── src/humanchat/
│   ├── mcp_core.py             # MCP 协议核心：工具/资源/提示词/强制规则
│   ├── transports.py           # stdio + Streamable HTTP（含 SSE 心跳）
│   ├── broker.py               # 会话、消息、等待队列、持久化、UDS/TCP 服务
│   ├── backend.py              # local / remote 后端 + 交接服务
│   ├── cli.py                  # 人类终端界面（TUI + 逐行模式 + 子命令）
│   ├── webui.py                # 人类浏览器界面（HTTP + SSE 服务端）
│   ├── webui_assets.py         # 浏览器界面的 HTML/CSS/JS（全部内联，零外链）
│   ├── launcher.py             # 自动打开终端（tmux / Terminal.app / 各种模拟器）
│   ├── const.py                # 规则文本、工具名、消息类型
│   └── config.py               # 环境变量与路径
├── humanchat-web.ps1           # Windows 启动浏览器界面（默认开启局域网访问）
├── tests/                      # 41 个测试：stdio/HTTP/PTY/重连/local+remote/Web+SSE/SDK 兼容
├── examples/demo_agent.py      # 本地体验：模拟守规矩的 Agent（不用 AgentDock）
└── docs/                       # 接入指南、协议说明、规则片段、终端预览
```

```bash
python3 -m unittest discover -s tests -v          # 全部测试（约 28 秒）
python3 -m unittest tests.test_webui -v           # 只跑浏览器界面相关（约 3 秒）
pip install "mcp"  && python3 -m unittest tests.test_sdk_compat -v   # 官方 SDK 交叉验证
pytest -q                                          # 也可以
```

---

## 12. 与 AgentDock 的关系

本项目是**独立的第三方 MCP 服务器**，与 AgentDock 项目无隶属关系，仅通过标准
MCP 协议（stdio / streamable HTTP）与它对接；AgentDock 侧无需任何改动。
AgentDock 采用 Apache-2.0 许可，本项目同样以 Apache-2.0 发布。

## LICENSE

Apache-2.0
