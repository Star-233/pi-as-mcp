# 把 HumanChat MCP 接入 AgentDock

本文是给**人**和**Agent**共同看的操作手册。AgentDock 通过 `mcp_manage` 注册外部 MCP，
通过 `mcp_tool_call` 调用工具，所以下面所有配置都是 AgentDock 的原生概念，不需要改 AgentDock 源码。

---

## 0. 前置条件

1. AgentDock 已安装并运行（本机、VPS 或容器）。
2. 目标机器上有 Python 3.8+（`python3 --version` 能跑就行）。**不需要 pip install 任何东西。**
3. 本项目已拷贝到该机器，例如 `/opt/humanchat-mcp`：

```bash
python3 /opt/humanchat-mcp/humanchat_mcp.py --version
# humanchat-mcp 1.0.0
```

> 路径必须是**绝对路径**，且 AgentDock 运行在同一台机器 / 同一个容器里
> （`transport: stdio` 要求这样）。

---

## 1. 注册（stdio，推荐）

在 ChatGPT（或任何接了 AgentDock 的客户端）里对 Agent 说：

> 用 AgentDock 的 `mcp_manage` 注册一个本地 MCP 服务，然后刷新并验证：
>
> ```
> action=add
> name=humanchat
> description=人类在环终端对话：任务结束后等待人类提问
> transport=stdio
> command=python3
> args=["/opt/humanchat-mcp/humanchat_mcp.py", "--stdio"]
> timeout_ms=300000
> enabled=true
> ```
>
> 然后 `action=refresh`，再用 `mcp_tool_search` 搜 `human`，确认能看到
> `human_notify` / `human_wait` / `human_status` / `human_rules`。

Agent 实际发出的两次调用大致是：

```json
{"name": "agentdock:mcp_manage",
 "arguments": {"action": "add", "name": "humanchat", "description": "人类在环终端对话",
               "transport": "stdio", "command": "python3",
               "args": ["/opt/humanchat-mcp/humanchat_mcp.py", "--stdio"],
               "timeout_ms": 300000, "enabled": true}}

{"name": "agentdock:mcp_manage", "arguments": {"action": "refresh", "name": "humanchat"}}
```

`timeout_ms` 建议直接写 **300000**（AgentDock 允许的上限）：它是单次调用上限，
HumanChat 默认每 240s 分段返回一次，永远不会撞到这个上限。

需要透传环境变量时（例如自定义状态目录）：

```json
"env_from_env": {"HUMANCHAT_HOME": "HUMANCHAT_HOME"}
```

### 可选：HTTP 方式

```bash
# 常驻（可配合 systemd / supervisor）
HUMANCHAT_AUTOLAUNCH=always python3 /opt/humanchat-mcp/humanchat_mcp.py --http --port 8791
```

```json
{"action": "add", "name": "humanchat", "transport": "streamable_http",
 "url": "http://127.0.0.1:8791/mcp", "timeout_ms": 300000, "enabled": true}
```

HTTP 模式下长等待以 **SSE 流**返回：等待期间不断推 `notifications/progress` 心跳，
人类一说话就在同一个流里返回最终结果 —— 中间没有空转，也不会被“等太久”切断。

---

## 2. 让 Agent 每次都按规矩收尾

光注册还不够，要让 Agent **记得**调用。三个层次一起上：

### 2.1 注册时就把话说清楚（一次）

> 之后所有任务结束都不要直接结束对话：调用 `humanchat:human_notify`（`kind="done"`,
> `then_wait=true`）汇报并进入等待；收到 `status="keepalive"` 就立刻再次调用
> `humanchat:human_wait`，无限循环；永远不要使用内置的 ask/question 类工具；
> 只有我明确说“结束/退出/不用了”时才停止。

### 2.2 写进 `AGENTS.md`（持久生效）

把 [`agents-rules.md`](agents-rules.md) 的内容贴到 AgentDock 工作区的 `AGENTS.md`
（AgentDock 的 `workspace_context` 会加载工作区规则），这样每个新会话都会带上规则。

### 2.3 依赖 MCP 自身的“唠叨”

HumanChat 在四个位置重复规则：`initialize.instructions`、工具描述、**每次工具返回内容**、
以及 `human_rules` 工具。即使 Agent 忘了上下文，它调用 `human_wait` 时也会再次被提醒。

---

## 3. 人类打开界面（终端 TUI 或浏览器 Web）

正常情况：Agent 第一次调用 `human_notify` / `human_wait` 时，HumanChat 会**自动尝试**打开界面：

*界面形态由 `HUMANCHAT_UI` 决定：`tui`（默认）或 `web`。*

**TUI（默认）**
- 在 tmux 里 → 新窗口 `humanchat`（不抢焦点，`Ctrl+B n` 切过去）
- macOS → Terminal.app / iTerm2 新窗口
- Linux 图形界面 → `x-terminal-emulator`、`gnome-terminal`、`konsole`、`kitty`、`xterm` …
- Windows → Windows Terminal（`wt.exe`）/ `cmd start`
- 失败 → 把命令写进 `~/.humanchat/attach.txt`，并在工具返回里告诉 Agent，
  让 Agent 在对话里把命令转告你

**Web（`HUMANCHAT_UI=web`，推荐给“不想折腾终端”的场景）**
- 后台启动 `humanchat web --open`，由系统默认浏览器打开 `http://127.0.0.1:8792`
- **不需要任何终端模拟器**，所以容器 / 无图形界面的服务器上同样可用
  （此时在宿主机上访问映射出来的端口即可，记得配 `HUMANCHAT_WEB_HOST=0.0.0.0`）
- 已经有一个 Web 界面在跑时不会重复启动，只会再开一个标签页
- 失败 → 退回 TUI，并把命令写进 `~/.humanchat/attach.txt`

手动打开：

```bash
python3 /opt/humanchat-mcp/humanchat_mcp.py attach     # 终端界面
python3 /opt/humanchat-mcp/humanchat_mcp.py web        # 浏览器界面
# 或者： python3 -m humanchat attach / web
# 装了 pip 包的话： humanchat attach / humanchat-web
```

容器里：

```bash
# 终端界面（需要一个真终端）
docker exec -it <agentdock-container> python3 /opt/humanchat-mcp/humanchat_mcp.py attach
# 浏览器界面（在容器里起服务，宿主机浏览器访问）
docker exec -d <agentdock-container> python3 /opt/humanchat-mcp/humanchat_mcp.py web --host 0.0.0.0
docker port <agentdock-container> 8792        # 拿到宿主机端口后打开 http://localhost:<port>/?token=...
```

服务器上没有 tmux / 图形界面时，也可以从任何地方用一句话命令发消息：

```bash
HUMANCHAT_HOME=/home/me/.humanchat python3 /opt/humanchat-mcp/humanchat_mcp.py send "继续"
```

---

## 4. 验证清单

| 步骤 | 期望结果 |
| --- | --- |
| `mcp_manage action=list` | 出现 `humanchat`，`status=ready`，`tool_count=4` |
| `mcp_tool_inspect humanchat:human_wait` | 描述里含“严禁使用内置提问工具”“keepalive 必须继续调用” |
| `mcp_tool_call humanchat:human_status {}` | 返回 `human_attached: true/false`、会话列表、接入命令 |
| `mcp_tool_call humanchat:human_notify {"text":"测试","kind":"note"}` | 人类界面立刻出现这条消息 |
| 人类在界面里回一句，Agent 调 `human_wait` | 返回 `status="human_message"` + 人类原话 |
| Agent 说“已完成”之后 | 它调用 `human_notify(..., then_wait=true)` 并停在 `human_wait` 循环里，**没有结束对话** |

---

## 5. 常见问题

**Q：Agent 一直在 `human_wait` 循环里刷工具调用，正常吗？**
A：正常，而且这正是设计目标 —— 每 240s 一次续等。人类随时说话会立刻返回。
若你希望它真的一次调用等到天荒地老（客户端没有单次调用上限），把 `keepalive_seconds` 设为 `0`。

**Q：AgentDock 报 `MCP_TOOL_TIMEOUT` / 调用被取消？**
A：把注册时的 `timeout_ms` 调到 `300000`，并确认 `human_wait` 的 `keepalive_seconds`
明显小于它（默认 240 就是为此选的）。被取消也不会丢消息，Agent 立刻重新调用即可取回。

**Q：TUI 不好用 / 想用浏览器？**
A：`HUMANCHAT_UI=web` 写进注册的 `env`（或直接 `python3 humanchat_mcp.py web`）。
Web 界面和 TUI 同源，可以同时开着；详细说明见 [`web-ui.md`](web-ui.md)。

**Q：AgentDock 重启后人类界面断了？**
A：界面会自动重连。想完全避免，用常驻 broker：
`python3 humanchat_mcp.py --broker --daemon`（或 systemd user service，见 README 第 7 节）。

**Q：多个 AgentDock 实例 / 多台设备？**
A：给每个实例一个会话：注册 stdio 时加 `--session device-a` / `--session device-b`，
人类界面用 `Tab` 或 `/switch <id>` 切换。所有会话共享一个 broker。

**Q：安全吗？**
A：broker 默认只监听本机 Unix socket（`chmod 600`）。要跨容器/跨机用 TCP 时，
请设置 `HUMANCHAT_TOKEN` 并让人类侧带上同样的令牌；HTTP MCP 同样用
`Authorization: Bearer <HUMANCHAT_TOKEN>`（AgentDock 侧用 `header_env` 传）。
Web 界面默认只监听 `127.0.0.1`；一旦改成监听其它地址会**自动生成访问令牌**并打印带
token 的地址，也可以 `--token` 固定。

---

## 6. 卸载

```bash
python3 /opt/humanchat-mcp/humanchat_mcp.py quit-broker   # 停掉常驻 broker（如已启动）
```

然后对 Agent 说：`mcp_manage action=remove name=humanchat`；删除 `~/.humanchat`
（会话记录、日志）和项目目录即可。
