# HumanChat Web 界面（浏览器版人类界面）

> TUI 的替代品：不用折腾终端快捷键，直接在浏览器里和 Agent 对话。
> 手机、平板、另一台电脑也能接入（同一局域网 / 隧道）。
> **零依赖**：纯 Python 标准库实现，页面资源全部内联，不装 npm、不引 CDN、离线可用。

```
        Agent（ChatGPT / Claude / Codex，经 AgentDock）
                        │  MCP stdio / streamable HTTP
                        ▼
              humanchat MCP server
                        │
                        ▼
                 broker（会话 / 消息 / 等待队列 / 落盘）
                  ▲                        ▲
                  │ NDJSON（UDS/TCP）      │ NDJSON
                  │                        │
        人类界面 A：TUI               人类界面 B：Web（本文）
        humanchat attach              humanchat web
```

两个界面**完全同源**：都是 broker 的 `role=human` 客户端。可以同时开着，
消息、会话、Agent 等待状态实时同步；一个界面里发的消息，另一个界面立刻能看到。

---

## 1. 怎么用（三条命令，任选）

```bash
python3 humanchat_mcp.py web                 # 起服务 + 自动打开浏览器（127.0.0.1:8792）
python3 humanchat_mcp.py web --port 9000     # 换端口
python3 humanchat_mcp.py web --no-open       # 只起服务，不开浏览器
```

Windows 上直接**双击**仓库里的 `humanchat-web.bat`（或 `humanchat-web.ps1`）即可。

装过 pip 包的话，也可以直接用入口脚本：

```bash
humanchat-web                # == python3 humanchat_mcp.py web
humanchat-web --port 9000
```

启动后终端会打印一行带令牌的地址，例如：

```
  HumanChat Web 界面已启动
  ─────────────────────────────────────────────
  会话      : human-in-the-loop
  本机地址  : http://127.0.0.1:8792/
  局域网    : http://192.168.1.23:8792/?token=8f3k...
  访问令牌  : 8f3k...
```

**让 Agent 自动打开 Web 界面**（而不是 TUI）：在 AgentDock 注册 MCP 时加一个环境变量

```json
{"HUMANCHAT_UI": "web"}
```

之后 Agent 第一次需要人类界面时（`human_notify` / `human_wait`），launcher 会
在后台起一个 `humanchat web --open`，浏览器自动弹出；`attach_command` 提示里给出的
命令也会变成 `humanchat web`，Agent 转告人类时自然就是浏览器版。

已经有一个 Web 界面在跑时，重复执行 `web` **不会**再起一个进程 —— 它只会再开一个
标签页（省得出现两个界面各说各话）。确实想另起一个：`--force-new`。

---

## 2. 界面功能

| 区域 | 功能 |
| --- | --- |
| 左侧会话列表 | 每个会话一行：标题、最后一条消息摘要、相对时间、未读徽标、**Agent 正在等待**的跳动小点；支持搜索框过滤；点击切换（切换即重连该会话的 SSE） |
| 顶栏 | 会话标题（**双击重命名**）、状态胶囊（`🔔 正在等待你的回复 (mm:ss)` 实时计时 / `Agent 正在工作`）、在对话中搜索、强制规则、通道状态、导出记录 |
| 消息区 | 角色气泡（Agent 左 / 你 右）、`kind` 徽标（完成 / 提问 / 进度 / 错误 / 备注）、日期分隔、当天时间戳、**Markdown 渲染**（标题、列表、行内代码、代码块 + 复制按钮、链接、粗斜体）、鼠标悬停出现「复制 / 引用 / 重读」 |
| 底部输入区 | Enter 发送、Shift+Enter 换行、自动增高、↑ 取回历史、输入 `/` 弹出命令菜单、识别「结束 / 退出 / exit」并在提示条上告诉你这句会让 Agent 收尾 |
| 提示 | Agent 开始等待 → 提示音 + 桌面通知；Agent 汇报完成/报错 → 不同提示音；标签页标题显示未读数 |
| 外观 | 深色 / 浅色（跟随系统，可手动切换，记忆在 localStorage） |
| 窄屏 | ≤880px 自动收成抽屉式会话栏，手机上可正常使用（含安全区适配） |

### `/` 命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 快捷键 + 命令总览 |
| `/new [id]` | 新建会话（留空自动生成 id） |
| `/rename <标题>` | 重命名当前会话 |
| `/switch <id>` | 切换会话 |
| `/clear` | 清空当前会话（含磁盘记录，不可撤销） |
| `/export` | 导出当前会话为 Markdown |
| `/status` | 通道状态（broker、pid、人类窗口数、未处理消息、接入命令） |
| `/rules` | 查看强制规则原文 |
| `/search <关键词>` | 在对话里搜索（高亮 + 匹配数） |
| `/sound` | 开 / 关提示音 |
| `/theme` | 深色 / 浅色 |

### 快捷键

| 键 | 作用 |
| --- | --- |
| `Enter` / `Shift+Enter` | 发送 / 换行 |
| `Ctrl+K` | 搜索会话 |
| `Ctrl+F` | 在对话里搜索 |
| `Ctrl+Shift+N` | 新建会话 |
| `Esc` | 关闭弹层 / 搜索框 |
| `↑` / `↓` | 输入历史 |

---

## 3. 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--host <addr>` | 监听地址，默认 `127.0.0.1`；填 `0.0.0.0` 可让局域网/手机访问（**会自动生成令牌**） |
| `--port <n>` / `-p` | 监听端口，默认 `8792`（被占用时自动往后找） |
| `--session <id>` / `-s` | 默认打开的会话，默认 `HUMANCHAT_SESSION` 或 `default` |
| `--open` / `--no-open` / `--no-browser` | 是否自动打开浏览器（默认打开） |
| `--token <t>` | 固定访问令牌（默认：仅本机监听时不启用；监听公网地址时随机生成） |
| `--require-token` / `--no-token` | 强制要求 / 强制关闭令牌 |
| `--cors` / `--no-cors` | 是否发送 `Access-Control-Allow-Origin`（默认：无令牌时开，有令牌时关） |
| `--force-new` | 即使已有实例在跑，也另起一个 |
| `--no-spawn` | broker 不在时不自动拉起（只连现有的） |

---

## 4. HTTP 接口（脚本 / 自建前端可直接用）

| 方法 + 路径 | 说明 |
| --- | --- |
| `GET /` | 页面本体（内联 CSS/JS，无外链） |
| `GET /healthz` | `{"ok":true,"app":"humanchat-web",...}`，**不需要令牌**，用于探活 |
| `GET /api/state?session=<id>` | 会话快照 + 会话列表 + 连接状态 + 人类窗口数 + 接入命令 |
| `GET /api/history?session=<id>&limit=N` | 单个会话的历史（默认 500 条） |
| `GET /api/sessions` | 会话列表 |
| `GET /api/rules` | 强制规则文本 |
| `GET /api/export?session=<id>[&download=1]` | 导出 Markdown（`download=1` 时带 `Content-Disposition`） |
| `GET /api/events?session=<id>` | **SSE 事件流**（见下） |
| `POST /api/send` | `{session, text}` 人类发言 |
| `POST /api/session/new` | `{session?, title?}` 新建会话 |
| `POST /api/session/rename` | `{session, title}` 重命名 |
| `POST /api/session/clear` | `{session}` 清空 |
| `POST /api/status` | `{session, consume?}` 通道状态（`consume=true` 会取走未处理消息） |
| `POST /api/auth` | `{token}` 换取 `hc_token` Cookie（令牌模式下前端用） |
| `POST /api/shutdown` | 让 broker 停止（危险） |

**SSE 事件**（与 broker 事件同名，前端直接消费）：

```
{"event":"snapshot",  "session":"default", "session_data":{...}}
{"event":"sessions",  "sessions":[...]}
{"event":"message",   "session":"default", "message":{seq,ts,role,kind,text,...}}
{"event":"status",    "session":"default", "status":{state,since,reason,hint}}
{"event":"clients",   "humans":2}
{"event":"cleared",   "session":"default"}
{"event":"connection","connected":false,"error":"broker 连接已断开，正在重连"}
```

心跳：每 15s 一条注释行 `: ping`；断线由浏览器 `EventSource` 自行带 `retry: 1500` 重连。

**鉴权**：令牌模式下支持三种传法 —— `?token=xxx`、`Cookie: hc_token=xxx`（打开一次带 token
的地址即自动种下）、`Authorization: Bearer xxx`。

```bash
# 例子：给 Agent 发一句话，并等它的下一条回复
curl -s -X POST http://127.0.0.1:8792/api/send \
     -H 'Content-Type: application/json' \
     -d '{"session":"default","text":"继续"}'
curl -sN http://127.0.0.1:8792/api/events?session=default | head -c 2000
```

---

## 5. 安全

* **默认只监听 `127.0.0.1`**，只有本机能访问，不启用令牌（体验优先）。
* 一旦监听非本机地址（`--host 0.0.0.0`、`0.0.0.0`、局域网 IP、域名……），
  **自动生成随机令牌**并打印带 token 的地址；没带令牌的请求返回 401（页面显示一个输入框）。
* 想固定令牌：`--token my-secret` 或环境变量 `HUMANCHAT_WEB_TOKEN`。
* 令牌校验用 `secrets.compare_digest` 常量时间比较；Cookie 为 `HttpOnly; SameSite=Lax`。
* 令牌只保护 Web 界面；broker 本身仍按原有方式（本机 UDS/TCP + 可选 `HUMANCHAT_TOKEN`）保护。
* 想暴露到公网：建议再套一层反向代理 + HTTPS（记住 SSE 需要关掉响应缓冲，
  例如 nginx：`proxy_buffering off; proxy_read_timeout 3600s;`），或直接用
  `cloudflared` / `tailscale` 这类隧道。

---

## 6. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HUMANCHAT_UI` | `tui` | 人类界面形态：`tui`（终端）或 `web`（浏览器）。影响 Agent 自动打开哪一种、以及提示给人类的接入命令 |
| `HUMANCHAT_WEB_HOST` | `127.0.0.1` | `web` 子命令默认监听地址 |
| `HUMANCHAT_WEB_PORT` | `8792` | 默认端口 |
| `HUMANCHAT_WEB_TOKEN` | 空 | 固定令牌；为空时按上面的规则决定 |
| `HUMANCHAT_WEB_OPEN` | `auto` | `auto`（自动开浏览器）/ `never` |
| `HUMANCHAT_HOME` | `~/.humanchat` | 状态目录；Web 界面会把运行信息写进 `$HOME/web.json`（端口 / 令牌 / pid），供二次启动复用 |

---

## 7. 行为细节（为什么这么设计）

**断线自愈。** 浏览器只跟 Web 服务器说话；Web 服务器跟 broker 之间由后台线程维持长连接。
broker 消失（典型场景：AgentDock 重启了 stdio MCP 进程）时：

1. Web 服务器立刻把在飞的请求全部失败掉，页面上出现红色横幅「与 broker 断开，正在重连…」；
2. 后台线程每 1.5s 重试一次，必要时自己拉起一个常驻 broker；
3. 连上以后推送 `connection` + `snapshot` 事件，页面**不刷新**就恢复到最新状态。

**去重。** 每条消息有 `(session, seq)`。SSE 事件、快照、重连重放都用它去重，
所以「先连上 SSE 再拉快照」这种竞态不会导致消息显示两遍。

**多端并存。** broker 本来就支持多个人类客户端：TUI 一个、手机浏览器一个、
另开一个标签页一个，互不干扰；`/api/state` 里的 `human_clients` 就是当前窗口数。

**为什么不用 WebSocket？** `http.server` 是同步模型，SSE 用 `wfile.write` 就够；
SSE 还自带断线重连、比 WebSocket 少一层握手与依赖，且可以直接 `curl -N` 调试。

**一台机器一个 broker。** `find_endpoint()` 会先看当前 `HUMANCHAT_HOME` 里的
`broker.json`，找不到就探测默认端点（POSIX：`$HUMANCHAT_HOME/broker.sock`；Windows：
`tcp://127.0.0.1:8790`）。所以第二次启动的界面（TUI 或 Web）会**接上已经在跑的那个 broker**，
而不是各起一个 —— 这正是「人和 Agent 总在同一个会话里」的前提。

**为什么资源要内联？** 目标环境常常是离线机器 / 容器 / 内网，引 CDN 会白屏。
整个页面（含 CSS + JS）约 56 KB，一次响应发完，没有第二次请求。

---

## 8. 排查

| 现象 | 处理 |
| --- | --- |
| 打开是「需要一个访问令牌」 | 用启动时打印的带 `?token=` 的地址；或把终端里的 token 粘进去 |
| 页面显示 401 JSON | 用浏览器打开 `/`（会显示输入框），别直接开 `/api/...` |
| 端口被占用 | 会自动往后找端口，看启动输出里的实际地址；也可以用 `--port` 指定 |
| 手机打不开 | 确认 `--host 0.0.0.0`、手机和电脑同一网段、防火墙放行该端口；用打印的「局域网」地址（带 token） |
| 页面上一直「与 broker 断开」 | 看 `$HUMANCHAT_HOME/logs/broker.log`；确认 `python3 humanchat_mcp.py --broker` 能正常起来 |
| 新起的 Web 界面「接上了别人的 broker」 | 正常现象：一台机器共用一个 broker。Windows 上（Python 没编 AF_UNIX 时）broker 走 `tcp://127.0.0.1:8790`，**跨 `HUMANCHAT_HOME` 共享**；想彻底隔离（比如跑测试）设 `HUMANCHAT_TCP=1` + `HUMANCHAT_TCP_PORT=<空闲端口>` |
| 提示音不响 | 浏览器要求先与页面交互一次才允许发声（点击任意位置后再试）；`/sound` 可开关注释；桌面通知需要授权 |
| 局域网访问想用 HTTPS | 用反向代理或隧道；SSE 记得关缓冲 |
| 想看运行信息 | `cat $HUMANCHAT_HOME/web.json`（端口 / 令牌 / pid / 版本） |

---

## 9. 测试

```bash
python3 -m unittest tests.test_webui -v     # 18 个：页面/接口/SSE/令牌/断线重连/复用
python3 -m unittest discover -s tests -v    # 全部（41 个）
```

覆盖点：页面无外链（离线可用）、`/api/*` 全链路、SSE 推送、令牌的三种传法、
**杀掉 broker 后自动重连并恢复收发**、重复启动复用同一实例、`HUMANCHAT_UI=web` 的命令拼装。
