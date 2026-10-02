# 协议与契约（HumanChat MCP）

本文档描述 HumanChat 的对外契约，便于二次开发、写测试或替换前端。

---

## 1. MCP 层

- 协议版本：`2025-06-18`（同时也兼容 `2025-03-26`、`2024-11-05`；服务端会回显客户端请求的版本）
- 传输：`stdio`（NDJSON，一行一条 JSON-RPC）与 `streamable_http`（`POST /mcp`，支持 `text/event-stream`）
- 能力：`tools`、`resources`、`prompts`、`logging`
- 根路径：stdio 无路径；HTTP 为 `/mcp`（`/` 与 `/message` 亦接受），另有 `GET /healthz`
- 会话（HTTP）：`initialize` 返回 `Mcp-Session-Id` 响应头，后续请求需回传；`DELETE /mcp` 结束会话；
  `GET /mcp` 返回 405（规范允许，服务端不提供独立 SSE 流）

### 1.1 工具清单

| 工具 | 说明 | 关键参数 |
| --- | --- | --- |
| `human_notify` | 把消息推到人类终端 | `text`（必填）、`kind`、`session_id`、`then_wait`、`keepalive_seconds`、`reason`、`hint` |
| `human_wait` | **等待人类的下一条消息**（收尾必备） | `session_id`、`reason`、`hint`、`keepalive_seconds`、`max_wait_seconds` |
| `human_status` | 通道状态 / 取回积压消息 | `session_id`、`include_backlog` |
| `human_rules` | 返回强制规则文本 | — |

`kind` 取值：`message` | `question` | `progress` | `done` | `error` | `note`

### 1.2 `human_wait` 返回值（`structuredContent.status`）

| status | 含义 | Agent 必须做什么 |
| --- | --- | --- |
| `human_message` | 收到人类消息，原话在 `message.text` | 回答它，然后**再次调用 `human_wait`** |
| `keepalive` | 到 `keepalive_seconds` 时间点了，但还没有人类消息 | **立刻再次调用 `human_wait`**（不是超时、不是结束信号） |
| `timeout` | 达到调用方显式设置的 `max_wait_seconds` | 若仍需人类输入就继续等待 |
| `cancelled` | 客户端取消了调用（连接断开 / 单次调用超时） | 立刻重新调用 `human_wait`；消息不会丢 |

文本内容里始终附带：本次等待时长、人类终端是否已连接、**下一步必须执行的动作**，以及强制规则提醒。

### 1.3 等待语义

```
wait(session, keepalive, max_wait, heartbeat)
    ├─ 消息到达（人类侧 append）  → 立即返回 ("message", msg)，并标记该消息 consumed
    ├─ keepalive 到期            → 返回 ("keepalive", elapsed)，消息队列保持不动
    ├─ max_wait 到期             → 返回 ("timeout", elapsed)
    └─ cancel / 连接断开         → 返回 ("cancelled", elapsed)
期间每 heartbeat 秒触发一次心跳回调 → 传输层发 notifications/progress（有 progressToken 时）
                                    或 notifications/message（log，低频）
```

- `keepalive = 0` 表示**真正不返回**（服务端无限等待），适用于没有单次调用上限的客户端。
- 默认 `keepalive = 240s`：刻意小于 AgentDock 的 300s 请求上限。
- 状态机：等待开始 → `agent_status.state = "waiting"`（人类界面显示等待计时器）；
  等待结束 → `"working"`。
- **消费语义**：人类消息只有被 `human_wait` 或 `human_status(include_backlog=true)` 取出时才算消费；
  其余情况一直保持在队列里，因此进程重启、连接断开、客户端超时都不会丢消息。

### 1.4 资源与提示词

| URI / name | 内容 |
| --- | --- |
| `humanchat://rules` | 强制规则（中英） |
| `humanchat://protocol` | 交接协议说明（等价于 `instructions`） |
| `humanchat://sessions` | 会话列表与通道状态（JSON） |
| `humanchat://transcript/latest`（或 `/transcript/<session_id>`） | 会话记录文本 |
| prompt `human_handoff` | 把“notify + then_wait + keepalive 循环”的要求注入当前对话 |

### 1.5 规则注入点

1. `initialize.instructions`
2. 每个工具的 `description`（含 `⚠️` 级警告）
3. **每一次工具返回文本的尾部**（`━━ HUMANCHAT 强制提醒 ━━` 三条 + 本次下一步）
4. `human_rules` 工具 / `humanchat://rules` 资源 / `human_handoff` 提示词

---

## 2. Broker 层（人类侧与 MCP 侧共用）

传输：Unix socket（默认 `~/.humanchat/broker.sock`，权限 600）或 TCP（`HUMANCHAT_TCP=1`）。
编码：NDJSON，UTF-8。

```
请求: {"id": "<任意>", "cmd": "...", ...}
响应: {"id": "<原样回填>", "ok": true, "data": {...}}
      {"id": "<原样回填>", "ok": false, "error": {"code": "...", "message": "..."}}
事件: {"event": "message" | "status" | "sessions" | "cleared" | "clients" | "wait_*", ...}
```

### 2.1 人类客户端命令

| cmd | 参数 | 说明 |
| --- | --- | --- |
| `hello` | `role="human"`, `client`, `session` | 返回 server 信息 + 该会话快照（含历史消息） |
| `send` | `session`, `text`, `meta` | 人类发言；唤醒所有等待者 |
| `history` | `session`, `limit` | 会话消息 |
| `sessions` | — | 会话列表 |
| `new` / `rename` / `clear` / `export` | `session`, `title`/`path` | 会话管理 |
| `status` | `session` | Agent 状态、未处理消息、人类连接数、接入命令 |
| `ping` | — | 存活探测 |

### 2.2 MCP 侧命令（本机模式下直接调用内部 API；远程模式下走同一套命令）

| cmd | 参数 | 说明 |
| --- | --- | --- |
| `hello` | `role="mcp"` | 以 MCP 身份接入现有 broker |
| `append` | `session`, `kind`, `text`, `meta` | Agent → 人类终端（落盘 + 广播 `message` 事件） |
| `set_status` | `session`, `state`, `reason`, `hint` | 更新 Agent 状态（`idle`/`working`/`waiting`） |
| `wait` | `session`, `keepalive_seconds`, `max_wait_seconds`, `heartbeat_seconds` | 远程等待；过程中推 `wait_progress` / `wait_keepalive` 事件，最终返回 `{"status": ...}` |
| `status` / `sessions` | `session` | 供 `human_status` 使用 |
| `shutdown` | — | 停止 broker（`humanchat quit-broker`） |

远程等待使用**独立连接**，因此不会阻塞主连接上的其它命令。

### 2.3 事件

| event | 触发时机 | 载荷 |
| --- | --- | --- |
| `message` | 任意一方发言 | `session`, `message{seq,ts,role,kind,text,meta}` |
| `status` | Agent 状态变化 | `session`, `status{state,since,reason,hint}` |
| `sessions` | 会话增删改 | `sessions[]` |
| `cleared` | 会话被清空 | `session` |
| `clients` | 人类客户端接入/离开 | `humans` |
| `wait_progress` / `wait_keepalive` / `wait_message` | 远程等待过程 | `elapsed` / `message` |

---

## 3. 落盘格式

```
$HUMANCHAT_HOME/
├── broker.json                  # 运行中 broker 的 pid / endpoint（人类 CLI 与 MCP 用它发现 broker）
├── broker.sock                  # Unix socket（或使用 TCP）
├── attach.txt                   # 自动拉起终端失败时写下的接入命令
├── logs/broker.log
└── sessions/
    ├── <session>.jsonl          # 每条消息一行（append-only，重启后回放）
    └── <session>.meta.json      # 会话摘要
```

消息对象：`{seq, ts, role(agent|human|system), kind, text, session_id, consumed, meta}`。
`consumed=true` 表示已被 Agent 取走。

---

## 4. 并发与生命周期

- 一个 `HUMANCHAT_HOME` 同时只有一个 broker：启动时先探测（`ping`），探测到存活进程就以
  **远程客户端**身份接入，探测到僵尸 socket 文件则清理后自行监听。
- MCP 进程与 broker 的两种关系：
  - **local**：MCP 进程自己就是 broker（默认，AgentDock 拉起 stdio 时常见）
  - **remote**：已有常驻 broker（`--broker --daemon`），MCP 作为客户端接入
- 人类 TUI 在断线时会自动重连（30 次尝试），期间输入界面仍然可用。
- `SIGINT` / `SIGTERM` 会优雅关闭：关闭连接、清理 socket 文件、保留会话数据。

---

## 5. 兼容性验证

| 客户端 | stdio | streamable HTTP |
| --- | --- | --- |
| 官方 MCP Python SDK 1.30.0 | ✅ | ✅ |
| 官方 MCP Python SDK 2.2.0 | ✅ | ✅ |
| 裸 JSON-RPC（内置测试客户端） | ✅ | ✅ |

AgentDock 使用官方 Go SDK，遵循同一协议版本组合，测试覆盖了 `initialize` / `tools/list` /
`tools/call` / 通知 / 取消 / SSE 心跳等路径。
