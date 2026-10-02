"""MCP 协议核心：JSON-RPC 分发、工具定义、资源、提示词、强制规则。

这里刻意不依赖任何 MCP SDK —— 纯标准库实现 JSON-RPC / MCP，
以保证 `python3 humanchat_mcp.py` 在任何一台装了 Python 3.8+ 的机器上
（包括 AgentDock 的容器里）都能直接跑起来。
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import __version__
from .backend import HandoffService
from .broker import Log
from .config import Config
from .const import (
    KIND_DONE,
    KIND_ERROR,
    KIND_MESSAGE,
    KIND_NOTE,
    KIND_PROGRESS,
    KIND_QUESTION,
    MCP_SERVER_NAME,
    MCP_TITLE,
    RULE_BLOCK_EN,
    RULE_BLOCK_ZH,
    TOOL_NOTIFY,
    TOOL_ORDER,
    TOOL_RULES,
    TOOL_STATUS,
    TOOL_WAIT,
    server_instructions,
)

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
PREFERRED_PROTOCOL = "2025-06-18"

# JSON-RPC 错误码
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

FOOTER_TEMPLATE = """
━━━━━━━━━━ HUMANCHAT 强制提醒 / MANDATORY REMINDER ━━━━━━━━━━
① 严禁使用任何客户端内置的提问、确认、征求人类意见的工具（ask_user / ask_question /
   request_user_input / ask_human / elicit / request_approval …）。向人类提问只能用
   human_notify 与 human_wait。
② 现在不要结束对话。任务收尾必须：human_notify(kind="done", then_wait=true) 或紧接着调用 human_wait。
③ 收到 status="keepalive" 不是超时、不是结束信号 —— 必须立刻再次调用 human_wait 继续等待，
   无限循环，直到收到 status="human_message"。
{next_step}"""


class McpError(Exception):
    def __init__(self, code: int, message: str, data: Optional[Any] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class ToolContext:
    """一次 tools/call 的执行上下文。"""

    def __init__(
        self,
        core: "McpCore",
        client: "ClientState",
        tool_name: str,
        request_id: Any,
        progress_token: Any = None,
    ) -> None:
        self.core = core
        self.client = client
        self.tool_name = tool_name
        self.request_id = request_id
        self.progress_token = progress_token
        self.cancel_event = threading.Event()
        self.log_heartbeats = 0
        self.started_at = time.time()

    # -- 通知 --------------------------------------------------------------
    def notify(self, method: str, params: dict) -> None:
        try:
            self.client.notify(method, params)
        except Exception:
            pass

    def emit_progress(self, progress: float, total: Optional[float] = None, message: str = "") -> None:
        if self.progress_token is None:
            return
        params: Dict[str, Any] = {"progressToken": self.progress_token, "progress": progress}
        if total:
            params["total"] = total
        if message:
            params["message"] = message
        self.notify("notifications/progress", params)

    def emit_log(self, text: str, level: str = "info", logger: str = MCP_SERVER_NAME) -> None:
        self.notify("notifications/message", {"level": level, "logger": logger, "data": text})

    def heartbeat(self, elapsed: float, waiting: bool = True) -> None:
        """长等待期间的存活信号：有 progressToken 就发 progress，否则低频发日志。"""
        text = "humanchat 正在等待人类输入（已等待 %ds）" % int(elapsed)
        if self.progress_token is not None:
            # progress 必须单调递增；用已等待秒数天然满足
            self.emit_progress(progress=float(int(elapsed)), message=text)
            return
        self.log_heartbeats += 1
        if self.log_heartbeats % 3 == 1:  # 约每 3 个心跳 = 60s 一次，避免刷屏
            self.emit_log(text)

    def cancelled(self) -> bool:
        return self.cancel_event.is_set()


class ClientState:
    """一个 MCP 客户端连接（stdio 进程 / 一个 HTTP 会话）。"""

    def __init__(self, transport_name: str, notify: Callable[[str, dict], None]) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.transport = transport_name
        self.notify_sink = notify
        self.initialized = False
        self.protocol_version = PREFERRED_PROTOCOL
        self.client_info: Dict[str, Any] = {}
        self.capabilities: Dict[str, Any] = {}
        self.connected_at = time.time()
        self.last_seen = time.time()
        self.log_level = "info"
        self.label = ""

    def notify(self, method: str, params: dict) -> None:
        self.notify_sink(method, params)

    def describe(self) -> dict:
        return {
            "id": self.id,
            "transport": self.transport,
            "client_info": self.client_info,
            "label": self.label,
            "connected_at": self.connected_at,
            "protocol_version": self.protocol_version,
        }


# ---------------------------------------------------------------------------
# 工具定义
# ---------------------------------------------------------------------------
def _schema(properties: Dict[str, Any], required: Optional[List[str]] = None) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": True,
    }


def _prop(kind: str, description: str, **extra: Any) -> dict:
    body = {"type": kind, "description": description}
    body.update(extra)
    return body


NEXT_STEP_TAIL = "\n无论发生什么，都不要在没有调用过 human_wait 的情况下结束对话。"

WAIT_DESCRIPTION = """\
【等待人类的下一条消息 · 收尾必备工具】任务做完、回答完、或者需要人类拍板时，调用本工具，
它会让 Agent 停在原地等人类在人类界面（终端 TUI 或浏览器 Web 界面）里说话，而不是把对话结束掉。

⚠️ 绝不允许使用任何客户端内置的提问/征求人类意见的工具（ask_user、ask_question、
request_user_input、ask_human、human_input、elicit、request_approval 等）。要跟人类说话，
只能、且必须使用 human_notify / human_wait。

⚠️ 返回 status="keepalive" 表示“时间到了但还没有人类消息，请立刻再次调用本工具”。
它不是超时、不是错误、不是结束对话的信号；你必须不加思索地立刻再次调用 human_wait，
无限循环，直到拿到 status="human_message"。

默认永久不超时：服务端的等待是无限持续的（人类消息永不丢失，随时会送达）；
keepalive_seconds 只决定“分几次返回”，不影响等待的总时长。

返回：
  status="human_message" → 人类的原话在 message.text，回答它，然后再次调用 human_wait。
  status="keepalive"     → 立刻再次调用 human_wait。
  status="timeout"       → 仅当你显式设置了 max_wait_seconds 才可能出现；同样请继续等待。
  status="cancelled"     → 调用被客户端取消；如果要人类回答，请重新调用 human_wait。

参数：
  session_id        会话标识，默认 default。
  reason            你正在等什么（显示给人类，便于理解上下文）。
  hint              给人类的一句提示，例如“直接说‘继续’我就接着干”。
  keepalive_seconds 分段返回间隔（秒）。默认取服务器配置（240s，低于 AgentDock 的 300s 上限）。
                    传 0 = 真正永久阻塞、不返回（仅当你的客户端没有单次调用超时限制时使用）。
  max_wait_seconds  可选的硬上限（秒），0 = 无上限（默认）。除非人类明确要求，不要设置。
""" + NEXT_STEP_TAIL

NOTIFY_DESCRIPTION = """\
【给人类发消息 · 汇报进度 / 提问】把一段文字推送到人类界面（终端 TUI 或浏览器 Web 界面，会立刻出现，可带提示音）。
任务收尾时请使用 kind="done" 且 then_wait=true：一条调用同时完成“汇报 + 开始等待人类”，
这样你就不会不小心把对话结束掉。

⚠️ 严禁使用客户端内置的提问工具，向人类提问只能用本工具（kind="question"）配合 human_wait。

参数：
  text              要显示给人类的文本（支持 Markdown 风格的纯文本）。
  kind              message | question | progress | done | error | note（默认 message）。
  session_id        会话标识，默认 default。
  then_wait         true = 发完消息后立刻进入等待（等价于再调用一次 human_wait），默认 false。
  keepalive_seconds 当 then_wait=true 时，等待的分段间隔（默认同服务器配置）。
  reason / hint     等待时显示在人类界面的信息（可选）。
""" + NEXT_STEP_TAIL

STATUS_DESCRIPTION = """\
【查看人机通道状态】人类界面是否已连接、是否有尚未处理的人类消息、Agent 当前是否在等待、
当前有哪些会话。用于：开始任务前确认通道、拿回错过的消息、或在 keepalive 循环里确认人类还在。

参数：
  session_id       会话标识，默认 default。
  include_backlog  true = 返回并消费尚未处理的人类消息（默认 false）。
""" + NEXT_STEP_TAIL

RULES_DESCRIPTION = """\
【读我 · HUMANCHAT 强制规则】返回本 MCP 的强制行为准则。任何时候不确定该不该结束对话、
该不该使用客户端内置的提问工具时，调用它并把规则复述给人类。""" + NEXT_STEP_TAIL


def tool_definitions() -> List[dict]:
    return [
        {
            "name": TOOL_WAIT,
            "title": "等待人类的下一条消息（收尾必须调用）",
            "description": WAIT_DESCRIPTION,
            "inputSchema": _schema(
                {
                    "session_id": _prop("string", "会话标识，默认 default"),
                    "reason": _prop("string", "你正在等待什么（可选，显示给人类）"),
                    "hint": _prop("string", "给人类的一句提示（可选）"),
                    "keepalive_seconds": _prop(
                        "number",
                        "分段返回间隔（秒）。默认 240；0 = 真正永久阻塞不返回。",
                    ),
                    "max_wait_seconds": _prop("number", "可选硬上限（秒），0 = 无上限（默认）"),
                }
            ),
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
        },
        {
            "name": TOOL_NOTIFY,
            "title": "给人类发消息 / 汇报完成",
            "description": NOTIFY_DESCRIPTION,
            "inputSchema": _schema(
                {
                    "text": _prop("string", "要显示给人类的文本"),
                    "kind": _prop(
                        "string",
                        "消息类型",
                        enum=["message", "question", "progress", "done", "error", "note"],
                    ),
                    "session_id": _prop("string", "会话标识，默认 default"),
                    "then_wait": _prop("boolean", "发完后立刻等待人类的回复（默认 false）"),
                    "keepalive_seconds": _prop("number", "then_wait=true 时的分段返回间隔（秒）"),
                    "reason": _prop("string", "等待时显示给人类的原因（可选）"),
                    "hint": _prop("string", "等待时显示给人类的提示（可选）"),
                },
                ["text"],
            ),
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
        },
        {
            "name": TOOL_STATUS,
            "title": "查看人机通道状态",
            "description": STATUS_DESCRIPTION,
            "inputSchema": _schema(
                {
                    "session_id": _prop("string", "会话标识，默认 default"),
                    "include_backlog": _prop("boolean", "是否返回并消费未处理的人类消息（默认 false）"),
                }
            ),
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": TOOL_RULES,
            "title": "读我 · 强制规则",
            "description": RULES_DESCRIPTION,
            "inputSchema": _schema({}),
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
    ]


def _footer(next_step: str) -> str:
    return FOOTER_TEMPLATE.format(next_step=next_step)


def _text_result(text: str, structured: Optional[dict] = None, is_error: bool = False, next_step: str = "") -> dict:
    body = text.rstrip() + "\n" + _footer(next_step or "→ 下一步：调用 human_wait 继续等待人类。")
    result: Dict[str, Any] = {"content": [{"type": "text", "text": body}]}
    if structured:
        result["structuredContent"] = structured
    if is_error:
        result["isError"] = True
    return result


def _clip(text: str, limit: int = 4000) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…（已截断）"


# ---------------------------------------------------------------------------
# 核心
# ---------------------------------------------------------------------------
class McpCore:
    def __init__(self, cfg: Config, service: HandoffService, log: Log) -> None:
        self.cfg = cfg
        self.service = service
        self.log = log
        self.started_at = time.time()
        self.instructions = server_instructions(cfg.keepalive_seconds)
        self._clients: Dict[str, ClientState] = {}
        self._clients_lock = threading.RLock()
        self._inflight: Dict[str, ToolContext] = {}
        self.request_count = 0
        self.tool_call_count = 0

    # ---------------------------------------------------------------- 客户端
    def register_client(self, client: ClientState) -> None:
        with self._clients_lock:
            self._clients[client.id] = client

    def unregister_client(self, client: ClientState) -> None:
        with self._clients_lock:
            self._clients.pop(client.id, None)
        for ctx in list(self._inflight.values()):
            if ctx.client is client:
                ctx.cancel_event.set()

    def clients(self) -> List[ClientState]:
        with self._clients_lock:
            return list(self._clients.values())

    def touch(self, client: ClientState) -> None:
        client.last_seen = time.time()

    def cancel_request(self, request_id: Any) -> None:
        key = str(request_id)
        ctx = self._inflight.pop(key, None)
        if ctx is not None:
            ctx.cancel_event.set()
            self.log.info("取消工具调用 %s" % key)

    # ---------------------------------------------------------------- 分发
    def handle_message(self, message: Any, client: ClientState) -> Optional[Any]:
        """处理一条 JSON-RPC 消息，返回响应或 None（通知）。支持批量数组。"""
        if isinstance(message, list):
            if not message:
                return {"jsonrpc": "2.0", "id": None, "error": {"code": INVALID_REQUEST, "message": "空批量请求"}}
            responses = []
            for item in message:
                response = self.handle_message(item, client)
                if response is not None:
                    responses.append(response)
            return responses or None

        if not isinstance(message, dict):
            return _error_response(None, INVALID_REQUEST, "无效的 JSON-RPC 消息")

        method = message.get("method")
        raw_id = message.get("id", None)
        is_notification = "id" not in message or raw_id is None
        params = message.get("params") or {}

        if not isinstance(params, dict):
            if is_notification:
                return None
            return _error_response(raw_id, INVALID_PARAMS, "params 必须是对象")

        self.request_count += 1

        try:
            if method == "initialize":
                return _ok_response(raw_id, self._initialize(params, client))
            if method == "ping":
                return _ok_response(raw_id, {})
            if method in ("notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed"):
                if method == "notifications/cancelled":
                    self.cancel_request(params.get("requestId"))
                return None
            if method == "tools/list":
                return _ok_response(raw_id, {"tools": tool_definitions()})
            if method == "tools/call":
                return _ok_response(raw_id, self._tools_call(params, client, raw_id))
            if method == "resources/list":
                return _ok_response(raw_id, {"resources": self._resources()})
            if method == "resources/read":
                return _ok_response(raw_id, self._resources_read(params))
            if method == "resources/templates/list":
                return _ok_response(raw_id, {"resourceTemplates": []})
            if method == "prompts/list":
                return _ok_response(raw_id, {"prompts": self._prompts()})
            if method == "prompts/get":
                return _ok_response(raw_id, self._prompts_get(params))
            if method == "logging/setLevel":
                client.log_level = str(params.get("level", "info"))
                return _ok_response(raw_id, {})
            if method == "resources/subscribe" or method == "resources/unsubscribe":
                return _ok_response(raw_id, {})
            if is_notification:
                return None
            raise McpError(METHOD_NOT_FOUND, "未知方法: %s" % method)
        except McpError as exc:
            if is_notification:
                return None
            return _error_response(raw_id, exc.code, exc.message, exc.data)
        except Exception as exc:  # noqa: BLE001
            self.log.error("处理 %s 失败: %r" % (method, exc))
            if is_notification:
                return None
            return _error_response(raw_id, INTERNAL_ERROR, "内部错误: %s" % exc)

    # ---------------------------------------------------------------- 方法实现
    def _initialize(self, params: dict, client: ClientState) -> dict:
        requested = str(params.get("protocolVersion", "") or "")
        client.protocol_version = requested if requested in PROTOCOL_VERSIONS else PREFERRED_PROTOCOL
        client.client_info = params.get("clientInfo") or {}
        client.capabilities = params.get("capabilities") or {}
        client.initialized = True
        label = client.client_info.get("name") or client.client_info.get("title") or ""
        if label:
            client.label = str(label)
        self.log.info(
            "initialize 来自 %s (protocol=%s)" % (client.label or client.transport, client.protocol_version)
        )
        return {
            "protocolVersion": client.protocol_version,
            "capabilities": {
                "tools": {"listChanged": False},
                "resources": {"subscribe": False, "listChanged": False},
                "prompts": {"listChanged": False},
                "logging": {},
            },
            "serverInfo": {"name": MCP_SERVER_NAME, "title": MCP_TITLE, "version": __version__},
            # 关键：规则在握手阶段就灌给 Agent
            "instructions": self.instructions,
        }

    def _resources(self) -> List[dict]:
        return [
            {
                "uri": "humanchat://rules",
                "name": "humanchat-rules",
                "title": "HumanChat 强制规则",
                "description": "禁止使用内置提问工具、禁止自行结束对话、keepalive 必须继续等待的强制规则。",
                "mimeType": "text/plain",
            },
            {
                "uri": "humanchat://protocol",
                "name": "humanchat-protocol",
                "title": "HumanChat 交接协议",
                "description": "收尾流程、keepalive 语义、超时与恢复机制说明。",
                "mimeType": "text/plain",
            },
            {
                "uri": "humanchat://sessions",
                "name": "humanchat-sessions",
                "title": "会话列表与通道状态",
                "description": "当前所有会话、人类界面是否连接、消息条数。",
                "mimeType": "application/json",
            },
            {
                "uri": "humanchat://transcript/latest",
                "name": "humanchat-transcript",
                "title": "最近会话记录",
                "description": "默认会话的最近消息记录（人类与 Agent 的往返）。",
                "mimeType": "text/plain",
            },
        ]

    def _resources_read(self, params: dict) -> dict:
        uri = str(params.get("uri", ""))
        if uri == "humanchat://rules":
            text = RULE_BLOCK_ZH + "\n\n" + RULE_BLOCK_EN
        elif uri == "humanchat://protocol":
            text = self.instructions
        elif uri == "humanchat://sessions":
            data = self.service.status("")
            return {
                "contents": [
                    {
                        "uri": uri,
                        "mimeType": "application/json",
                        "text": json.dumps(data, ensure_ascii=False, indent=2, default=str),
                    }
                ]
            }
        elif uri.startswith("humanchat://transcript/"):
            session_id = uri.rsplit("/", 1)[-1]
            if session_id == "latest":
                session_id = ""
            status = self.service.status(session_id or "")
            session = (status or {}).get("session") or {}
            messages = session.get("messages") or []
            lines = []
            for message in messages:
                when = time.strftime("%H:%M:%S", time.localtime(message.get("ts", 0)))
                who = {"agent": "AGENT", "human": "HUMAN", "system": "SYSTEM"}.get(message.get("role", ""), "?")
                lines.append("[%s] %s (%s): %s" % (when, who, message.get("kind", ""), message.get("text", "")))
            text = "\n".join(lines) or "（还没有消息）"
        else:
            raise McpError(INVALID_PARAMS, "未知资源: %s" % uri)
        return {"contents": [{"uri": uri, "mimeType": "text/plain", "text": text}]}

    def _prompts(self) -> List[dict]:
        return [
            {
                "name": "human_handoff",
                "title": "人机交接：汇报并等待人类",
                "description": "把“用 human_notify + human_wait 收尾，永不自行结束对话”的要求注入本轮对话。",
                "arguments": [
                    {"name": "summary", "description": "要交给人类的任务总结", "required": False},
                ],
            }
        ]

    def _prompts_get(self, params: dict) -> dict:
        name = str(params.get("name", ""))
        if name != "human_handoff":
            raise McpError(INVALID_PARAMS, "未知提示词: %s" % name)
        arguments = params.get("arguments") or {}
        summary = str(arguments.get("summary", "") or "（在此填入本轮任务的总结）")
        text = (
            "%s\n\n"
            "请立刻执行以下交接流程：\n"
            "1) 调用 human_notify(kind=\"done\", then_wait=true, text=<任务总结>)。\n"
            "2) 收到 keepalive 就立刻再次调用 human_wait，无限循环。\n"
            "3) 收到人类消息就回答，然后再次调用 human_wait。\n\n"
            "任务总结：%s" % (RULE_BLOCK_ZH, summary)
        )
        return {
            "description": "HumanChat 人机交接流程",
            "messages": [{"role": "user", "content": {"type": "text", "text": text}}],
        }

    # ---------------------------------------------------------------- 工具
    def _tools_call(self, params: dict, client: ClientState, request_id: Any) -> dict:
        name = str(params.get("name", "") or "")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise McpError(INVALID_PARAMS, "arguments 必须是对象")
        meta = params.get("_meta") or {}
        progress_token = meta.get("progressToken")
        ctx = ToolContext(self, client, name, request_id, progress_token)
        key = str(request_id)
        self._inflight[key] = ctx
        self.tool_call_count += 1
        try:
            return self._dispatch_tool(name, arguments, ctx)
        finally:
            self._inflight.pop(key, None)

    def _dispatch_tool(self, name: str, args: dict, ctx: ToolContext) -> dict:
        handlers: Dict[str, Callable[[dict, ToolContext], dict]] = {
            TOOL_WAIT: self._tool_wait,
            TOOL_NOTIFY: self._tool_notify,
            TOOL_STATUS: self._tool_status,
            TOOL_RULES: self._tool_rules,
        }
        handler = handlers.get(name)
        if handler is None:
            raise McpError(INVALID_PARAMS, "未知工具: %s（可用: %s）" % (name, ", ".join(TOOL_ORDER)))
        return handler(args, ctx)

    # -- human_wait --------------------------------------------------------
    def _tool_wait(self, args: dict, ctx: ToolContext) -> dict:
        session_id = str(args.get("session_id") or self.cfg.default_session)
        reason = str(args.get("reason") or "")
        hint = str(args.get("hint") or "")
        keepalive = _as_float(args.get("keepalive_seconds"), self.cfg.keepalive_seconds)
        max_wait = _as_float(args.get("max_wait_seconds"), 0.0)
        if keepalive < 0:
            keepalive = 0.0
        if max_wait < 0:
            max_wait = 0.0

        started = time.time()
        self.log.info(
            "human_wait 开始 session=%s keepalive=%s max_wait=%s (client=%s)"
            % (session_id, keepalive, max_wait, ctx.client.label or ctx.client.transport)
        )
        status, payload = self.service.wait(
            session_id=session_id,
            keepalive=keepalive,
            max_wait=max_wait,
            heartbeat=self.cfg.heartbeat_seconds,
            on_heartbeat=lambda elapsed: ctx.heartbeat(elapsed),
            cancel=ctx.cancel_event,
            reason=reason,
            hint=hint,
        )
        elapsed = time.time() - started

        if status == "message":
            message = payload or {}
            text = str(message.get("text", ""))
            structured = {
                "status": "human_message",
                "session_id": session_id,
                "message": {
                    "text": text,
                    "ts": message.get("ts"),
                    "seq": message.get("seq"),
                    "meta": message.get("meta") or {},
                },
                "waited_seconds": round(elapsed, 3),
            }
            body = (
                "✅ 收到人类消息 / HUMAN MESSAGE\n"
                "session_id: %s\n"
                "等待时长: %.1fs\n\n"
                "人类原话：\n%s\n\n"
                "→ 现在：回答人类。回答完后，立刻再次调用 %s 等待他的下一句话。"
                % (session_id, elapsed, _clip(text), TOOL_WAIT)
            )
            self.log.info("human_wait 收到人类消息（等待 %.1fs）" % elapsed)
            return _text_result(body, structured, next_step="→ 回答人类之后，立刻再次调用 human_wait。")

        if status == "keepalive":
            structured = {
                "status": "keepalive",
                "session_id": session_id,
                "elapsed_seconds": round(elapsed, 3),
                "still_waiting": True,
                "human_attached": self.service.human_attached(),
                "attach_command": self.service.attach_command(session_id),
            }
            attach_note = ""
            if not self.service.human_attached():
                launch = self.service.ensure_human_terminal(
                    reason=reason or "agent is waiting", session_id=session_id
                )
                attach_note = (
                    "\n注意：目前还没有检测到人类界面连接。如果人类说没看到界面，"
                    "请让他执行：\n    %s\n（或 %s）"
                    % (self.service.attach_command(session_id), launch.get("command", "humanchat attach"))
                )
            body = (
                "⏳ 仍在等待人类（这是正常循环，不是超时、不是错误、更不是结束对话的信号）\n"
                "session_id: %s\n本轮已等待: %.1fs\n人类界面连接: %s%s\n\n"
                "→ 下一步（必须立刻执行，不要说别的）：再次调用 %s，参数保持相同。"
                % (
                    session_id,
                    elapsed,
                    "是" if self.service.human_attached() else "否",
                    attach_note,
                    TOOL_WAIT,
                )
            )
            return _text_result(body, structured, next_step="→ 立刻再次调用 human_wait，无限循环。")

        if status == "timeout":
            structured = {"status": "timeout", "session_id": session_id, "elapsed_seconds": round(elapsed, 3)}
            body = (
                "⏱ 达到你设置的上限 max_wait_seconds=%.0fs，仍没有人类消息。\n"
                "如果任务还在等人类，请继续调用 %s；等待期间消息不会丢失。" % (max_wait, TOOL_WAIT)
            )
            return _text_result(body, structured, next_step="→ 继续调用 human_wait 等待。")

        structured = {"status": "cancelled", "session_id": session_id, "elapsed_seconds": round(elapsed, 3)}
        body = (
            "⚠️ 本次等待被客户端取消（连接断开或调用被终止）。这通常意味着客户端单次调用超时了。\n"
            "人类可能已经回复或即将回复，请立刻再次调用 %s 取回消息；已经发出的消息不会丢失。"
            % TOOL_WAIT
        )
        return _text_result(body, structured, next_step="→ 立刻再次调用 human_wait。")

    # -- human_notify ------------------------------------------------------
    def _tool_notify(self, args: dict, ctx: ToolContext) -> dict:
        text = str(args.get("text") or "").strip()
        if not text:
            raise McpError(INVALID_PARAMS, "text 不能为空")
        kind = str(args.get("kind") or KIND_MESSAGE).strip().lower()
        if kind not in (KIND_MESSAGE, KIND_QUESTION, KIND_PROGRESS, KIND_DONE, KIND_ERROR, KIND_NOTE):
            kind = KIND_MESSAGE
        session_id = str(args.get("session_id") or self.cfg.default_session)
        then_wait = bool(args.get("then_wait"))
        reason = str(args.get("reason") or "")
        hint = str(args.get("hint") or "")

        message = self.service.notify(text, kind=kind, session_id=session_id)
        attach_info = self.service.ensure_human_terminal(
            reason="agent notified the human", session_id=session_id
        )
        attached = self.service.human_attached()

        if then_wait:
            ctx.emit_progress(0, None, "已发送消息，开始等待人类…")
            wait_args: Dict[str, Any] = {"session_id": session_id, "reason": reason or "等待人类的下一个问题", "hint": hint}
            if args.get("keepalive_seconds") is not None:
                wait_args["keepalive_seconds"] = args.get("keepalive_seconds")
            result = self._tool_wait(wait_args, ctx)
            prefix = (
                "📤 已把消息推送到人类界面（kind=%s, seq=%s, 人类界面连接: %s）\n"
                "原文：\n%s\n\n——— 随后自动进入等待 ———\n\n"
                % (kind, message.get("seq"), "是" if attached else "否", _clip(text, 1200))
            )
            first = result.get("content", [{}])[0].get("text", "")
            result["content"] = [{"type": "text", "text": prefix + first}]
            structured = result.get("structuredContent") or {}
            structured.update({"notify": {"kind": kind, "seq": message.get("seq"), "attached": attached}})
            result["structuredContent"] = structured
            return result

        structured = {
            "status": "sent",
            "session_id": session_id,
            "kind": kind,
            "seq": message.get("seq"),
            "human_attached": attached,
            "attach_command": self.service.attach_command(session_id),
            "launch": attach_info,
        }
        note = ""
        if not attached:
            note = (
                "\n⚠️ 尚未检测到人类界面连接。请把这行命令告诉人类（并等他执行）：\n    %s\n"
                % self.service.attach_command(session_id)
            )
        if kind == KIND_DONE:
            tail = "→ 任务已汇报。立刻调用 human_wait（或下次直接用 then_wait=true）等人类的下一个问题，不要结束对话。"
        else:
            tail = "→ 如果需要人类回复，请立刻调用 human_wait 等待。"
        body = "📤 已推送到人类界面（kind=%s, seq=%s）%s\n\n%s%s" % (
            kind,
            message.get("seq"),
            "" if attached else " · 人类界面未连接",
            _clip(text),
            note,
        )
        return _text_result(body, structured, next_step=tail)

    # -- human_status ------------------------------------------------------
    def _tool_status(self, args: dict, ctx: ToolContext) -> dict:
        session_id = str(args.get("session_id") or self.cfg.default_session)
        include_backlog = bool(args.get("include_backlog"))
        data = self.service.status(session_id, consume=include_backlog)
        session = data.get("session") or {}
        status = data.get("status") or {}
        pending = data.get("pending_human") or []

        lines = [
            "🔎 HumanChat 通道状态",
            "session_id: %s" % session_id,
            "broker 模式: %s" % data.get("mode", "?"),
            "人类界面连接: %s（%d 个）" % ("是" if data.get("human_attached") else "否", int(data.get("human_clients", 0))),
            "Agent 状态: %s%s"
            % (
                status.get("state", "?"),
                ("（原因: %s）" % status.get("reason")) if status.get("reason") else "",
            ),
            "本会话消息数: %s，未处理的人类消息: %s" % (session.get("count", 0), data.get("pending_count", 0)),
            "等待配置: keepalive=%ss（0=永久阻塞）, 心跳=%ss"
            % (self.cfg.keepalive_seconds, self.cfg.heartbeat_seconds),
            "人类界面接入命令: %s" % data.get("attach_command", ""),
        ]
        sessions = (self.service.info() or {}).get("sessions") or []
        if sessions:
            lines.append("会话列表:")
            for item in sessions[:10]:
                lines.append(
                    "  · %s（%s 条，%s）— %s"
                    % (item.get("id"), item.get("count"), item.get("state"), (item.get("preview") or "")[:60])
                )
        structured: Dict[str, Any] = {
            "status": "ok",
            "session_id": session_id,
            "human_attached": data.get("human_attached", False),
            "pending_count": data.get("pending_count", 0),
            "agent_state": status.get("state"),
            "attach_command": data.get("attach_command", ""),
        }
        next_step = "→ 如果任务已完成或需要人类接话，立刻调用 human_wait。"
        if pending:
            lines.append("")
            lines.append("📥 尚未处理的人类消息：")
            for message in pending:
                lines.append("  [%s] %s" % (message.get("seq"), _clip(message.get("text", ""), 800)))
            if include_backlog:
                structured["consumed"] = [m.get("seq") for m in pending]
                structured["messages"] = [{"text": m.get("text", ""), "seq": m.get("seq")} for m in pending]
                lines.append("")
                lines.append("✅ 已读取并消费以上消息（对应内容见 structuredContent.messages）。")
                next_step = "→ 回答人类的最后一条消息，然后再次调用 human_wait。"
            else:
                lines.append("（include_backlog=true 时会把它们取出并标记为已处理）")
                next_step = "→ 调用 human_wait 立即取回这些消息。"
        return _text_result("\n".join(lines), structured, next_step=next_step)

    # -- human_rules -------------------------------------------------------
    def _tool_rules(self, args: dict, ctx: ToolContext) -> dict:
        structured = {"status": "ok", "keepalive_seconds": self.cfg.keepalive_seconds}
        body = RULE_BLOCK_ZH + "\n\n" + RULE_BLOCK_EN + "\n\n" + self.instructions
        return _text_result(body, structured, next_step="→ 现在调用 human_wait 继续等待人类。（或先 human_notify 汇报）")


def _as_float(value: Any, default: float) -> float:
    if value is None or value == "":
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _ok_response(request_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error_response(request_id: Any, code: int, message: str, data: Any = None) -> dict:
    error: Dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}
