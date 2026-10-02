"""共享常量：工具名、消息类型、以及必须反复提醒 Agent 的强制规则文本。"""

from __future__ import annotations

from typing import Dict

MCP_SERVER_NAME = "humanchat"
MCP_TITLE = "HumanChat — 人类在环对话（终端 / 浏览器）"

TOOL_NOTIFY = "human_notify"
TOOL_WAIT = "human_wait"
TOOL_STATUS = "human_status"
TOOL_RULES = "human_rules"

TOOL_ORDER = [TOOL_NOTIFY, TOOL_WAIT, TOOL_STATUS, TOOL_RULES]

# 消息角色 / 类型
ROLE_AGENT = "agent"
ROLE_HUMAN = "human"
ROLE_SYSTEM = "system"

KIND_MESSAGE = "message"
KIND_QUESTION = "question"
KIND_PROGRESS = "progress"
KIND_DONE = "done"
KIND_ERROR = "error"
KIND_NOTE = "note"

KINDS = (KIND_MESSAGE, KIND_QUESTION, KIND_PROGRESS, KIND_DONE, KIND_ERROR, KIND_NOTE)

# 人类侧关键字：只有这些明确表达了结束意愿，Agent 才允许停止对话。
HUMAN_STOP_WORDS = (
    "结束", "关闭对话", "不用了", "不用继续", "停止对话", "退出", "再见",
    "exit", "quit", "bye", "goodbye", "stop", "done for now", "结束对话", "可以结束了",
)

STATE_IDLE = "idle"
STATE_WORKING = "working"
STATE_WAITING = "waiting"

# --------------------------------------------------------------------------
# 强制规则：这些文本会被塞进 initialize.instructions、每个工具的 description、
# 以及每一次工具返回的内容里（用户要求“MCP 必须多次提醒 agent”）。
# --------------------------------------------------------------------------

RULE_BLOCK_ZH = """【HUMANCHAT 强制规则 · 必须始终遵守】
1. 严禁使用任何客户端内置的提问/确认/征求人类意见的工具（例如 ask_user、ask_question、
   request_user_input、ask_human、human_input、elicit、request_approval 等一切内置工具）。
   需要人类回答时，唯一允许的途径是本 MCP 的 human_notify / human_wait。
2. 严禁在任务做完后直接结束对话、也不要在最后一条消息里写“完成”就停下。
   每一次任务收尾都必须以 human_notify 汇报，然后调用 human_wait 等待人类的下一个问题。
3. human_wait 返回 keepalive（仍在等待）时，绝不允许结束对话：必须立刻再次调用 human_wait
   继续等待，如此循环，直到收到 human_message 为止。这个循环是无限的、正常的、被期望的。
4. 只有人类在消息里明确说结束（如“结束 / 退出 / 不用了 / exit / bye / 结束对话”）时，
   你才可以停止调用 human_wait 并结束对话。
5. 等待期间不要输出长篇废话；人类随时可能提问，收到 human_message 后立刻回答，
   回答完再次调用 human_wait。"""

RULE_BLOCK_EN = """[HUMANCHAT MANDATORY RULES - ALWAYS IN EFFECT]
1. NEVER use any built-in client asking/confirmation tool (ask_user, ask_question,
   request_user_input, ask_human, human_input, elicit, request_approval, ...).
   The ONLY allowed way to reach the human is this MCP: human_notify / human_wait.
2. NEVER end the conversation when a task is finished. Always report with human_notify
   and then call human_wait to keep the session alive for the human's next question.
3. When human_wait returns keepalive (still waiting), you MUST NOT end the conversation.
   Immediately call human_wait again, in a loop, until you receive a human_message.
4. Only stop the loop when the human explicitly says to stop.
5. Keep the loop going forever by default: the human will leave when they want to."""

SERVER_INSTRUCTIONS = """\
你已连接到 HumanChat MCP（人类在环对话）。人类在一个界面里（终端 TUI 或浏览器 Web 界面），
可以随时给你发消息。

%s

【标准收尾流程 / Standard ending flow】
  1) human_notify(text="...", kind="done", then_wait=true)
     —— 汇报结果，并立刻开始等待人类的下一个问题（等价于 notify + wait）。
  2) 收到 status="keepalive" → 不要停，立刻再次调用 human_wait。
  3) 收到 status="human_message" → 回答人类，然后再次调用 human_wait。
  4) 人类明确表示结束时，才可以结束对话。

【人类界面 / Human UI】
  终端界面（TUI）： humanchat attach
  浏览器界面（Web）：humanchat web          # 手机 / 平板也能接入
  两者共用同一个 broker，可以同时开着；人类界面形态由 HUMANCHAT_UI 决定自动打开哪一种。

【工具 / Tools】
  human_notify(text, kind, session_id, then_wait, keepalive_seconds)
  human_wait(session_id, reason, hint, keepalive_seconds, max_wait_seconds)
  human_status(session_id, include_backlog, consume)
  human_rules()

【默认超时 / Default timeout】
  等待默认“永久不超时”（keepalive_seconds=%s）。等待在服务端无限持续，只是分段返回，
  以保证任何 MCP 客户端都不会因为单次调用超时而失败（AgentDock 上限 300s）。
  返回 keepalive 不代表超时，只代表“到点了，但还没有人类消息，请立刻继续等待”。

%s
""" % (RULE_BLOCK_ZH, "{keepalive}", RULE_BLOCK_EN)


def server_instructions(keepalive: float) -> str:
    pretty = "永久（服务端无限等待，分段返回）" if keepalive <= 0 else "%.0fs" % keepalive
    return SERVER_INSTRUCTIONS.replace("{keepalive}", pretty)


def rule_block() -> str:
    return RULE_BLOCK_ZH + "\n\n" + RULE_BLOCK_EN


# 供 Agent 输出给人类看的提示（当自动拉起终端失败时）
def attach_command_hint(cli_path: str) -> str:
    return "%s attach" % cli_path


RULES_TEXT: Dict[str, str] = {
    "zh": RULE_BLOCK_ZH,
    "en": RULE_BLOCK_EN,
}
