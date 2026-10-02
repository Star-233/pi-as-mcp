"""MCP 传输层：stdio 与 Streamable HTTP（纯标准库实现）。

* stdio            —— AgentDock 用 `transport: "stdio"` 注册时使用。
* streamable HTTP  —— AgentDock 用 `transport: "streamable_http"` 注册时使用，
                      端点默认 http://127.0.0.1:8791/mcp 。

长等待期间会在这两条链路上持续推送
`notifications/progress`（客户端给了 progressToken 时）
与 `notifications/message` 心跳，既能保住连接，也能让客户端看到“还活着”。
"""

from __future__ import annotations

import json
import socket
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

from .broker import Log
from .config import Config
from .mcp_core import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    ClientState,
    McpCore,
    _error_response,
)


# ---------------------------------------------------------------------------
# stdio
# ---------------------------------------------------------------------------
class StdioTransport:
    def __init__(self, core: McpCore, log: Log) -> None:
        self.core = core
        self.log = log
        self._write_lock = threading.Lock()
        self._stop = threading.Event()
        self.client = ClientState("stdio", self._notify)

    def _write(self, payload: str) -> bool:
        data = (payload + "\n").encode("utf-8")
        with self._write_lock:
            try:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                return True
            except Exception:
                self._stop.set()
                return False

    def _notify(self, method: str, params: dict) -> None:
        self._write(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}, ensure_ascii=False))

    def send_response(self, response: Any) -> None:
        self._write(json.dumps(response, ensure_ascii=False, default=str))

    def run(self) -> None:
        self.core.register_client(self.client)
        stdin = sys.stdin.buffer
        self.log.info("MCP stdio 传输已就绪（等待客户端的 initialize）")
        while not self._stop.is_set():
            try:
                line = stdin.readline()
            except Exception as exc:
                self.log.warn("stdin 读取异常: %r" % (exc,))
                break
            if not line:
                break  # 客户端关闭 stdin → 退出
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line.decode("utf-8"))
            except Exception:
                self.send_response(_error_response(None, INVALID_REQUEST, "无效的 JSON"))
                continue
            self.core.touch(self.client)
            thread = threading.Thread(
                target=self._handle,
                args=(message,),
                name="mcp-stdio-msg",
                daemon=True,
            )
            thread.start()
        self._stop.set()
        self.core.unregister_client(self.client)
        self.log.info("stdio 传输结束")

    def _handle(self, message: Any) -> None:
        try:
            response = self.core.handle_message(message, self.client)
        except Exception as exc:  # noqa: BLE001
            self.log.error("处理消息失败: %r" % (exc,))
            response = _error_response(None, INTERNAL_ERROR, str(exc))
        if response is not None:
            self.send_response(response)


# ---------------------------------------------------------------------------
# Streamable HTTP
# ---------------------------------------------------------------------------
class HttpSessionState:
    def __init__(self, session_id: str, notify_sink) -> None:
        self.id = session_id
        self.client = ClientState("streamable_http", notify_sink)
        self.created_at = time.time()
        self.last_seen = time.time()
        self.active_stream = None
        self.lock = threading.Lock()


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "humanchat-mcp"

    # 由 HttpTransport 注入
    transport: "HttpTransport"

    # ------------------------------------------------------------ 基础方法
    def log_message(self, fmt: str, *args: Any) -> None:  # 静默默认日志
        self.transport.log.debug("%s - %s" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Mcp-Session-Id")

    def _json(self, status: int, payload: Any, session_id: str = "") -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if session_id:
            self.send_header("Mcp-Session-Id", session_id)
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _check_auth(self) -> bool:
        token = self.transport.token
        if not token:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            supplied = header[7:].strip()
            if supplied == token:
                return True
        self._json(401, {"error": "unauthorized", "message": "需要 Authorization: Bearer <HUMANCHAT_TOKEN>"})
        return False

    def _is_mcp_path(self) -> bool:
        path = self.path.split("?", 1)[0].rstrip("/")
        return path in ("", "/mcp", "/message", "/sse")

    # ------------------------------------------------------------ HTTP 动词
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/healthz", "/health"):
            info = self.transport.core.service.info()
            self._json(200, {"ok": True, "server": "humanchat", "sessions": len(info.get("sessions", [])) if isinstance(info, dict) else 0})
            return
        if self._is_mcp_path():
            # 规范允许：服务端不提供独立 SSE 流时返回 405
            self.send_response(405)
            self.send_header("Allow", "POST, DELETE, OPTIONS")
            self.send_header("Content-Type", "application/json")
            body = json.dumps({"error": "method_not_allowed", "hint": "使用 POST /mcp 发送 JSON-RPC"}).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self._json(404, {"error": "not_found", "path": path})

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._check_auth():
            return
        session_id = self.headers.get("Mcp-Session-Id", "")
        if session_id:
            self.transport.drop_session(session_id)
        self._json(200, {"ok": True, "terminated": session_id or None})

    def do_POST(self) -> None:  # noqa: N802
        if not self._check_auth():
            return
        if not self._is_mcp_path():
            self._json(404, {"error": "not_found", "path": self.path})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        if not raw:
            self._json(400, _error_response(None, INVALID_REQUEST, "空请求体"))
            return
        try:
            message = json.loads(raw.decode("utf-8"))
        except Exception:
            self._json(400, _error_response(None, -32700, "JSON 解析失败"))
            return

        accept = (self.headers.get("Accept") or "").lower()
        session_id = self.headers.get("Mcp-Session-Id", "").strip()
        state = self.transport.session(session_id) if session_id else None
        if session_id and state is None:
            self._json(404, _error_response(None, INVALID_REQUEST, "未知的 Mcp-Session-Id，请重新初始化"))
            return
        client_info = message.get("params") if isinstance(message, dict) and message.get("method") == "initialize" else None
        if state is None:
            state = self.transport.create_session(client_info or {})
            session_id = state.id

        # 纯通知 → 202，无响应体
        messages = message if isinstance(message, list) else [message]
        has_request = any(isinstance(m, dict) and m.get("id") is not None for m in messages)
        if not has_request:
            for item in messages:
                self.transport.core.handle_message(item, state.client)
            self.send_response(202)
            self.send_header("Mcp-Session-Id", session_id)
            self.send_header("Content-Length", "0")
            self._cors()
            self.end_headers()
            return

        if "text/event-stream" in accept:
            self._serve_sse(message, state, session_id)
        else:
            self._serve_json(message, state, session_id)

    # ------------------------------------------------------------ 响应模式
    def _serve_json(self, message: Any, state: HttpSessionState, session_id: str) -> None:
        responses = []
        items = message if isinstance(message, list) else [message]
        for item in items:
            response = self.transport.core.handle_message(item, state.client)
            if response is not None:
                responses.append(response)
        payload: Any = responses if isinstance(message, list) else (responses[0] if responses else None)
        if payload is None:
            self.send_response(202)
            self.send_header("Mcp-Session-Id", session_id)
            self.send_header("Content-Length", "0")
            self._cors()
            self.end_headers()
            return
        self._json(200, payload, session_id=session_id)

    def _serve_sse(self, message: Any, state: HttpSessionState, session_id: str) -> None:
        # SSE 需要结束流来界定消息边界，因此关闭连接（HTTP/1.1 + Connection: close）
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Mcp-Session-Id", session_id)
            self.send_header("Connection", "close")
            self._cors()
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            return
        self.close_connection = True
        write_lock = threading.Lock()
        cancelled = threading.Event()

        def push(payload: dict) -> bool:
            data = ("data: " + json.dumps(payload, ensure_ascii=False, default=str) + "\n\n").encode("utf-8")
            with write_lock:
                try:
                    self.wfile.write(data)
                    self.wfile.flush()
                    return True
                except Exception:
                    cancelled.set()
                    return False

        with state.lock:
            state.active_stream = push
        try:
            items = message if isinstance(message, list) else [message]
            responses = []
            for item in items:
                # 在独立线程里执行，保证 SSE 流不阻塞在长等待上（心跳仍可写出）
                result_box: Dict[str, Any] = {}

                def run(item=item, result_box=result_box) -> None:
                    try:
                        result_box["response"] = self.transport.core.handle_message(item, state.client)
                    except Exception as exc:  # noqa: BLE001
                        result_box["response"] = _error_response(None, INTERNAL_ERROR, str(exc))

                worker = threading.Thread(target=run, name="mcp-http-call", daemon=True)
                worker.start()
                while worker.is_alive():
                    worker.join(timeout=0.5)
                    if cancelled.is_set():
                        request_id = item.get("id") if isinstance(item, dict) else None
                        if request_id is not None:
                            self.transport.core.cancel_request(request_id)
                response = result_box.get("response")
                if response is not None:
                    responses.append(response)
                    if not push(response):
                        break
            if isinstance(message, list) and responses:
                push({"jsonrpc": "2.0", "id": None, "result": {"batch": len(responses)}})
        finally:
            with state.lock:
                if state.active_stream is push:
                    state.active_stream = None

    # ------------------------------------------------------------ 工具
    def _notify_from_session(self, state: HttpSessionState, method: str, params: dict) -> bool:
        with state.lock:
            sink = state.active_stream
        if sink is None:
            return False
        return sink({"jsonrpc": "2.0", "method": method, "params": params})


class HttpTransport:
    """Streamable HTTP 服务：POST /mcp 为主入口。"""

    def __init__(self, core: McpCore, cfg: Config, log: Log, host: Optional[str] = None, port: Optional[int] = None) -> None:
        self.core = core
        self.cfg = cfg
        self.log = log
        self.host = host or cfg.http_host
        # 注意：port=0 必须保留（让内核分配端口），只有 None 才回落到默认端口
        self.port = cfg.http_port if port is None else port
        self.token = cfg.token
        self._sessions: Dict[str, HttpSessionState] = {}
        self._lock = threading.RLock()
        self._httpd: Optional[ThreadingHTTPServer] = None

    # -- 会话 --------------------------------------------------------------
    def create_session(self, client_info: Optional[dict] = None) -> HttpSessionState:
        session_id = uuid.uuid4().hex
        state: HttpSessionState = HttpSessionState(
            session_id,
            notify_sink=lambda method, params: self._dispatch_notify(session_id, method, params),
        )
        with self._lock:
            self._sessions[session_id] = state
        self.core.register_client(state.client)
        self.log.info("HTTP 会话创建 %s" % session_id[:8])
        return state

    def session(self, session_id: str) -> Optional[HttpSessionState]:
        with self._lock:
            state = self._sessions.get(session_id)
        if state is not None:
            state.last_seen = time.time()
        return state

    def drop_session(self, session_id: str) -> None:
        with self._lock:
            state = self._sessions.pop(session_id, None)
        if state is not None:
            self.core.unregister_client(state.client)
            self.log.info("HTTP 会话结束 %s" % session_id[:8])

    def _dispatch_notify(self, session_id: str, method: str, params: dict) -> None:
        state = self.session(session_id)
        if state is None:
            return
        handler = _Handler
        with state.lock:
            sink = state.active_stream
        if sink is not None:
            sink({"jsonrpc": "2.0", "method": method, "params": params})
        else:
            self.log.debug("无活跃流，丢弃通知 %s" % method)

    # -- 生命周期 ----------------------------------------------------------
    def build_server(self) -> ThreadingHTTPServer:
        transport = self

        class _Server(ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

            def handle_error(self, request, client_address):  # 静默客户端断开
                exc = sys.exc_info()[1]
                if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
                    return
                transport.log.debug("HTTP 处理异常: %r" % (exc,))

        class _BoundHandler(_Handler):
            pass

        _BoundHandler.transport = self
        httpd = _Server((self.host, self.port), _BoundHandler)
        httpd.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._httpd = httpd
        return httpd

    def run(self) -> None:
        httpd = self.build_server()
        self.port = httpd.server_address[1]
        self.log.info("MCP Streamable HTTP 已监听 http://%s:%d/mcp" % (self.host, self.port))
        try:
            httpd.serve_forever(poll_interval=0.3)
        except KeyboardInterrupt:
            pass
        finally:
            with self._lock:
                for session_id in list(self._sessions):
                    self.drop_session(session_id)
            self.log.info("HTTP 传输结束")

    def stop(self) -> None:
        if self._httpd is not None:
            threading.Thread(target=self._httpd.shutdown, name="http-shutdown", daemon=True).start()
