"""HumanChat MCP — 让 Agent 停下来，等人类说话。

一个零依赖（纯 Python 标准库）的 MCP 服务器 + 人类终端界面：

  Agent (ChatGPT / Claude / Codex，经 AgentDock)
        │  MCP (stdio 或 streamable HTTP)
        ▼
  humanchat MCP server  ──►  broker（会话 / 消息 / 等待）
                                ▲
                                │  Unix socket / TCP
                                │
                    人类界面：TUI（终端）或 Web（浏览器）

设计目标：
  1. Agent 干完活不要直接把对话结束掉，而是调用 human_wait 等人类的下一个问题。
  2. 默认“永久不超时”：等待在服务端无限持续，同时按 keepalive 分段返回，
     以绕过 MCP 客户端（AgentDock 上限 300s）的单次调用超时；Agent 收到
     keepalive 必须立刻再次调用，形成永不结束的循环。
  3. 把“不许用内置提问工具 / 不许自行结束对话”的规则反复塞给 Agent：
     initialize.instructions、每个工具的 description、每次工具返回内容。
  4. 人类界面两种形态，共用同一个 broker，可以同时开着：
     * TUI：``humanchat attach``
     * Web：``humanchat web``（浏览器界面，手机/平板也能接入）
"""

__version__ = "1.1.0"
__all__ = ["__version__"]
