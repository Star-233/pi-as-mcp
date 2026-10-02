"""Human 侧 Web 界面：把 broker 的会话/消息/等待状态变成浏览器里的一个聊天窗口。

    python3 humanchat_mcp.py web                    # http://127.0.0.1:8792
    python3 humanchat_mcp.py web --open             # 顺带打开浏览器
    python3 humanchat_mcp.py web --host 0.0.0.0     # 手机/局域网访问（自动要求令牌）
    python3 humanchat_mcp.py web --token my-secret  # 指定令牌

设计要点
--------
* **零依赖**：只用标准库（``http.server`` + ``ThreadingHTTPServer`` + SSE），
  页面资源全部内联（见 ``webui_assets``），不请求任何外部域名，离线可用。
* **和 TUI 完全同源**：都是 broker 的 ``role=human`` 客户端，只是载体从终端换成浏览器。
  两个界面可以同时开着，消息、会话、Agent 状态完全一致。
* **断线自愈**：broker 消失（例如 AgentDock 重启了 MCP 进程）时后台自动重连，
  重连后把最新快照推给浏览器，页面不刷新也不丢消息。
* **多标签 / 多设备**：broker 本来就支持多个人类客户端，手机、平板、另一个窗口都能接入。
* **默认安全**：只在 127.0.0.1 上监听且不要求令牌；一旦监听非本机地址，自动生成令牌并打印
  带 token 的地址（也可以用 ``--token`` / ``HUMANCHAT_WEB_TOKEN`` 固定）。
"""

from __future__ import annotations

import json
import os
import queue
import secrets
import signal
import socket
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

from . import __version__
from .broker import Log
from .cli import BrokerClient, _ensure_broker
from .config import Config
from .const import RULE_BLOCK_EN, RULE_BLOCK_ZH
from .webui_assets import GATE_HTML, render_page

APP_ID = "humanchat-web"
SESSION_COOKIE = "hc_token"
SSE_PING_SECONDS = 15.0
HISTORY_LIMIT = 500


# ---------------------------------------------------------------------------
# 后端：一条人类连接到 broker + 向所有浏览器分发事件
# ---------------------------------------------------------------------------
class HubOffline(RuntimeError):
    """broker 当前不可用（断线重连中）。"""


class Hub:
    """维持“人类”角色到 broker 的长连接，并把事件扇出给所有 SSE 订阅者。

    只有这个对象持有 BrokerClient，HTTP 处理线程全部通过 ``request()`` 借道，
    因此不会出现多个连接抢消息的情况。
    """

    def __init__(self, cfg: Config, log: Log, session: str = "", spawn: bool = True) -> None:
        self.cfg = cfg
        self.log = log
        self.session = session or cfg.default_session
        self.spawn = spawn
        self.client: Optional[BrokerClient] = None
        self.endpoint = ""
        self.server_info: Dict[str, Any] = {}
        self.sessions: List[dict] = []
        self.human_clients = 0
        self.connected = False
        self.last_error = ""
        self.started_at = time.time()
        self._subs: List["queue.Queue[dict]"] = []
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._sessions_ts = 0.0
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------ 生命周期
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="webui-hub", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        client = self.client
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self.connected:
                if not self._connect():
                    self._broadcast({"event": "connection", "connected": False, "error": self.last_error})
                    self._stop.wait(1.5)
                    continue
            assert self.client is not None
            try:
                event = self.client.events.get(timeout=0.4)
            except queue.Empty:
                continue
            try:
                self._dispatch(event)
            except Exception as exc:  # noqa: BLE001 - 单个事件出错不能拖垮整个泵
                self.log.warn("处理 broker 事件失败: %r" % (exc,))
        self._teardown()

    def _connect(self) -> bool:
        self._drop_client()
        endpoint = _ensure_broker(self.cfg, self.log, spawn=self.spawn)
        if not endpoint:
            self.last_error = "找不到 broker（也没有可自动启动的入口）"
            return False
        client: Optional[BrokerClient] = None
        try:
            client = BrokerClient(self.cfg, endpoint, role="human", client_name="humanchat-web")
            hello = client.connect(session=self.session)
        except Exception as exc:  # noqa: BLE001
            self.last_error = "连接 broker 失败: %s" % (exc,)
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
            return False
        self.client = client
        self.endpoint = endpoint
        self.connected = True
        self.last_error = ""
        info = dict(hello.get("server") or {})
        info.setdefault("endpoint", endpoint)
        info.setdefault("version", __version__)
        self.server_info = info
        self.human_clients = int(info.get("human_clients") or 0)
        self.log.info("Web 界面已接入 broker: %s" % endpoint)
        snapshot = hello.get("history") or {}
        self._broadcast({"event": "connection", "connected": True, "server": self.server_info})
        if snapshot:
            self._broadcast({"event": "snapshot", "session": snapshot.get("id") or self.session, "session_data": snapshot})
        self._refresh_sessions(broadcast=True)
        return True

    def _drop_client(self) -> None:
        client, self.client = self.client, None
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    def _teardown(self) -> None:
        self.connected = False
        self._drop_client()
        if self.last_error == "":
            self.last_error = "broker 连接已关闭"
        self._broadcast({"event": "connection", "connected": False, "error": self.last_error})

    # ------------------------------------------------------------------ 事件分发
    def _dispatch(self, event: dict) -> None:
        name = event.get("event")
        if name == "disconnected":
            self.connected = False
            self.last_error = "broker 连接已关闭"
            return
        if name == "agent_message":
            # broker 对 Agent 消息会同时广播 message 与 agent_message，这里只保留前者
            return
        if name == "message":
            self._broadcast(event)
            self._touch_sessions()
            return
        if name == "clients":
            self.human_clients = int(event.get("humans") or 0)
            self._broadcast(event)
            return
        if name == "status":
            self._broadcast(event)
            self._touch_sessions()
            return
        if name == "sessions":
            self.sessions = event.get("sessions") or []
            self._broadcast(event)
            return
        self._broadcast(event)

    def _touch_sessions(self) -> None:
        """消息/状态变化后刷新一次会话列表（1.2s 内只刷一次，避免刷屏时打爆 broker）。"""
        with self._lock:
            now = time.time()
            if now - self._sessions_ts < 1.2:
                return
            self._sessions_ts = now
        threading.Thread(target=lambda: self._refresh_sessions(broadcast=True), daemon=True).start()

    def _refresh_sessions(self, broadcast: bool = False) -> None:
        try:
            data = self.request("sessions", timeout=8.0)
        except Exception:
            return
        self.sessions = data.get("sessions") or []
        if broadcast:
            self._broadcast({"event": "sessions", "sessions": self.sessions})

    # ------------------------------------------------------------------ 订阅
    def subscribe(self) -> "queue.Queue[dict]":
        box: "queue.Queue[dict]" = queue.Queue()
        with self._lock:
            self._subs.append(box)
        return box

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def touch_sessions(self) -> None:
        self._touch_sessions()

    def unsubscribe(self, box: "queue.Queue[dict]") -> None:
        with self._lock:
            if box in self._subs:
                self._subs.remove(box)

    def _broadcast(self, payload: dict) -> None:
        with self._lock:
            targets = list(self._subs)
        for box in targets:
            try:
                box.put_nowait(payload)
            except Exception:
                pass

    # ------------------------------------------------------------------ 请求代理
    def request(self, cmd: str, timeout: float = 15.0, **payload: Any) -> dict:
        client = self.client
        if client is None or not self.connected:
            raise HubOffline(self.last_error or "与 broker 断开，正在重连")
        try:
            return client.request(cmd, timeout=timeout, **payload)
        except Exception as exc:  # noqa: BLE001 - 断线统一翻译成 HubOffline，让上层给 503 / 断线横幅
            message = str(exc)
            if "断开" in message or "无响应" in message or "发送失败" in message:
                self.connected = False
                self.last_error = "broker 连接已断开，正在重连"
                raise HubOffline(self.last_error) from exc
            raise

    # ------------------------------------------------------------------ 状态快照
    def state(self, session_id: str = "") -> dict:
        session_id = session_id or self.session
        result: Dict[str, Any] = {
            "ok": True,
            "connected": self.connected,
            "error": "" if self.connected else (self.last_error or "与 broker 断开，正在重连"),
            "server": dict(self.server_info, endpoint=self.endpoint),
            "session_id": session_id,
            "sessions": self.sessions,
            "human_clients": self.human_clients,
            "pending_count": 0,
            "session": None,
            "version": __version__,
            "attach_command": self.attach_hint(session_id),
            "uptime": time.time() - self.started_at,
        }
        if not self.connected:
            return result
        try:
            data = self.request("history", session=session_id, limit=HISTORY_LIMIT)
        except Exception as exc:  # noqa: BLE001
            result["connected"] = False
            result["error"] = str(exc)
            return result
        snapshot = data.get("session") if isinstance(data.get("session"), dict) else data
        result["session"] = snapshot
        result["pending_count"] = int((snapshot or {}).get("pending_human") or 0)
        try:
            result["sessions"] = self.request("sessions", timeout=8.0).get("sessions") or self.sessions
        except Exception:
            pass
        return result

    def attach_hint(self, session_id: str = "") -> str:
        """给人类看的“另一个终端也能接入”的命令（TUI）。"""
        try:
            from . import launcher

            return launcher.cli_command(self.cfg, session_id or self.cfg.default_session)
        except Exception:
            return "python3 humanchat_mcp.py attach"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class WebServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, hub: Hub, token: str, cors: bool) -> None:
        super().__init__(addr, handler)
        self.hub = hub
        self.token = token
        self.cors = cors
        self.started_at = time.time()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "humanchat-web/%s" % __version__
    sys_version = ""

    # ------------------------------------------------------------- 基础设施
    @property
    def hub(self) -> Hub:
        return self.server.hub  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        self.hub.log.debug("web %s - %s" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        if getattr(self.server, "cors", False):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _cookie_token(self) -> str:
        raw = self.headers.get("Cookie") or ""
        if not raw:
            return ""
        try:
            jar = SimpleCookie()
            jar.load(raw)
            morsel = jar.get(SESSION_COOKIE)
            return morsel.value if morsel else ""
        except Exception:
            return ""

    def _query(self) -> Dict[str, List[str]]:
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _token_ok(self) -> bool:
        token = getattr(self.server, "token", "") or ""
        if not token:
            return True
        supplied = ""
        values = self._query().get("token")
        if values:
            supplied = values[0]
        if not supplied:
            supplied = self._cookie_token()
        if not supplied:
            header = self.headers.get("Authorization") or ""
            if header.lower().startswith("bearer "):
                supplied = header[7:].strip()
        return bool(supplied) and secrets.compare_digest(supplied, token)

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200,
                    extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, payload: Any, status: int = 200, extra: Optional[Dict[str, str]] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status=status, extra=extra)

    def _html(self, text: str, status: int = 200, extra: Optional[Dict[str, str]] = None) -> None:
        self._send_bytes(text.encode("utf-8"), "text/html; charset=utf-8", status=status, extra=extra)

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(min(length, 8 * 1024 * 1024))
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _fail(self, message: str, status: int = 400) -> None:
        self._json({"ok": False, "error": message}, status=status)

    # ------------------------------------------------------------- 路由
    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self._token_ok():
            return self._fail("需要访问令牌", status=401)
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        query = self._query()
        if path in ("/healthz", "/api/ping"):
            return self._json({"ok": True, "app": APP_ID, "version": __version__,
                               "connected": self.hub.connected, "session": self.hub.session})
        if not self._token_ok():
            if path == "/":
                return self._html(GATE_HTML, status=401)
            return self._fail("需要访问令牌（在启动 web 的终端里查看）", status=401)
        if path == "/":
            extra = {}
            if getattr(self.server, "token", "") and query.get("token"):
                extra["Set-Cookie"] = "%s=%s; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly" % (
                    SESSION_COOKIE, self.server.token)  # type: ignore[attr-defined]
            return self._html(render_page(), extra=extra)
        if path == "/api/state":
            session = (query.get("session") or [""])[0]
            return self._json(self.hub.state(session))
        if path == "/api/history":
            session = (query.get("session") or [""])[0]
            limit = _clamp_int((query.get("limit") or [HISTORY_LIMIT])[0], 1, 5000, HISTORY_LIMIT)
            try:
                data = self.hub.request("history", session=session, limit=limit)
            except HubOffline as exc:
                return self._fail(str(exc), status=503)
            return self._json(data.get("session") if isinstance(data.get("session"), dict) else data)
        if path == "/api/sessions":
            try:
                return self._json(self.hub.request("sessions"))
            except HubOffline as exc:
                return self._fail(str(exc), status=503)
        if path == "/api/rules":
            return self._json({"ok": True, "text": RULE_BLOCK_ZH + "\n\n" + RULE_BLOCK_EN})
        if path == "/api/export":
            session = (query.get("session") or [""])[0]
            try:
                data = self.hub.request("export", session=session, path="")
            except HubOffline as exc:
                return self._fail(str(exc), status=503)
            text = data.get("text") or ""
            extra = {}
            if (query.get("download") or ["0"])[0] in ("1", "true", "yes"):
                name = "humanchat-%s.md" % _safe_name(session or "default")
                extra["Content-Disposition"] = 'attachment; filename="%s"' % name
            return self._send_bytes(text.encode("utf-8"), "text/markdown; charset=utf-8", extra=extra)
        if path == "/api/events":
            return self._events((query.get("session") or [""])[0])
        return self._fail("未知路径: %s" % path, status=404)

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        body = self._read_json()

        # /api/auth 是“换取访问令牌”的入口，必须在令牌校验之前处理
        if path == "/api/auth":
            supplied = str(body.get("token") or "")
            token = getattr(self.server, "token", "") or ""
            if not token:
                return self._json({"ok": True, "required": False})
            if secrets.compare_digest(supplied, token):
                extra = {"Set-Cookie": "%s=%s; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly"
                                      % (SESSION_COOKIE, token)}
                return self._json({"ok": True, "required": True}, extra=extra)
            return self._fail("令牌不正确", status=401)

        if not self._token_ok():
            return self._fail("需要访问令牌", status=401)

        session = str(body.get("session") or "").strip() or self.hub.session
        try:
            if path == "/api/send":
                text = str(body.get("text") or "")
                if not text.strip():
                    return self._fail("消息不能为空")
                data = self.hub.request("send", session=session, text=text)
                return self._json({"ok": True, "message": data.get("message")})
            if path == "/api/session/new":
                payload: Dict[str, Any] = {"session": str(body.get("session") or "").strip()}
                if body.get("title"):
                    payload["title"] = str(body["title"])
                data = self.hub.request("new", **payload)
                self.hub.touch_sessions()
                return self._json({"ok": True, "session": data.get("session")})
            if path == "/api/session/rename":
                data = self.hub.request("rename", session=session, title=str(body.get("title") or ""))
                self.hub.touch_sessions()
                return self._json({"ok": True, "session": data.get("session")})
            if path == "/api/session/clear":
                data = self.hub.request("clear", session=session)
                return self._json({"ok": True, "session": data.get("session")})
            if path == "/api/status":
                return self._json(self.hub.request("status", session=session,
                                                   consume=bool(body.get("consume"))))
            if path == "/api/shutdown":
                self.hub.request("shutdown", timeout=3.0)
                return self._json({"ok": True, "stopping": True})
        except HubOffline as exc:
            return self._fail(str(exc), status=503)
        except Exception as exc:  # noqa: BLE001
            return self._fail(str(exc), status=400)
        return self._fail("未知路径: %s" % path, status=404)

    # ------------------------------------------------------------- SSE
    def _events(self, session: str) -> None:
        box = self.hub.subscribe()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Transfer-Encoding", "chunked")
            self._cors()
            self.end_headers()
            self._sse(b"retry: 1500\n: connected\n\n")
            snapshot = self.hub.state(session)
            self._sse_event({"event": "snapshot", "session": (snapshot.get("session") or {}).get("id") or session,
                             "session_data": snapshot.get("session")})
            self._sse_event({"event": "sessions", "sessions": snapshot.get("sessions") or []})
            self._sse_event({"event": "connection", "connected": snapshot.get("connected"),
                             "error": snapshot.get("error") or "", "server": snapshot.get("server") or {}})
            last_ping = time.time()
            while not self.hub.stopping:
                try:
                    payload = box.get(timeout=1.0)
                except queue.Empty:
                    if time.time() - last_ping >= SSE_PING_SECONDS:
                        last_ping = time.time()
                        self._sse(b": ping\n\n")
                    continue
                self._sse_event(payload)
                last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.hub.unsubscribe(box)
            try:
                self._sse(b"")  # 结束 chunked 流
            except Exception:
                pass
            self.close_connection = True

    def _sse(self, raw: bytes) -> None:
        frame = ("%X\r\n" % len(raw)).encode("ascii") + raw + b"\r\n"
        self.wfile.write(frame)
        self.wfile.flush()

    def _sse_event(self, payload: dict) -> None:
        body = ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")
        self._sse(body)


def _clamp_int(raw: Any, low: int, high: int, default: int) -> int:
    try:
        value = int(float(str(raw)))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


def _safe_name(text: str) -> str:
    return "".join(ch if (ch.isalnum() or ch in "-_.") else "_" for ch in text) or "default"


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------
def _is_loopback(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1", "127.1")


def _lan_addresses() -> List[str]:
    found: List[str] = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in found:
                found.append(ip)
    except Exception:
        pass
    if not found:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            found.append(probe.getsockname()[0])
        except Exception:
            pass
        finally:
            probe.close()
    return found


def web_state_file(cfg: Config):
    """记录正在运行的 Web 界面（端口 / 令牌 / pid），方便二次启动时直接复用。"""
    return cfg.home / "web.json"


def _read_web_state(cfg: Config) -> dict:
    path = web_state_file(cfg)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_web_state(cfg: Config, payload: dict) -> None:
    try:
        web_state_file(cfg).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def _clear_web_state(cfg: Config, pid: Optional[int] = None) -> None:
    path = web_state_file(cfg)
    try:
        if pid is not None:
            current = _read_web_state(cfg)
            if current.get("pid") not in (None, pid):
                return  # 别人接手了，不要删
        path.unlink()
    except OSError:
        pass


def probe_web(host: str, port: int, timeout: float = 0.8) -> Optional[dict]:
    """探测某个端口上是否已经是我们自己的 Web 界面。"""
    for candidate in (host, "127.0.0.1"):
        url = "http://%s:%d/healthz" % ("127.0.0.1" if candidate in ("0.0.0.0", "::") else candidate, port)
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, dict) and data.get("app") == APP_ID:
                data["url"] = url.replace("/healthz", "/")
                return data
        except Exception:
            continue
    return None


def find_running_web(cfg: Config) -> Optional[dict]:
    """返回已在运行的 Web 界面信息（优先用 web.json 里的端口/令牌）。"""
    state = _read_web_state(cfg)
    candidates = []
    if state.get("port"):
        candidates.append((str(state.get("host") or cfg.web_host), int(state["port"]), str(state.get("token") or "")))
    candidates.append((cfg.web_host, cfg.web_port, cfg.web_token))
    seen = set()
    for host, port, token in candidates:
        key = (host, port)
        if key in seen:
            continue
        seen.add(key)
        info = probe_web(host, port)
        if info:
            info["token"] = token or str(state.get("token") or "")
            info.setdefault("host", host)
            info.setdefault("port", port)
            return info
    return None


def reset_session(cfg: Config, log: Log, session: str, spawn: bool = True) -> bool:
    """清空某个会话（历史 + 未读队列）。用于 --fresh：每次启动都从零开始。"""
    endpoint = _ensure_broker(cfg, log, spawn=spawn)
    if not endpoint:
        log.warn("--fresh：找不到 broker，无法清空会话")
        return False
    client = None
    try:
        client = BrokerClient(cfg, endpoint, role="human", client_name="humanchat-reset")
        client.connect(session=session)
        client.request("clear", session=session)
        log.info("--fresh：已清空会话 %s" % session)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warn("--fresh：清空会话失败: %r" % (exc,))
        return False
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def _pick_port(host: str, port: int, attempts: int = 12) -> int:
    for offset in range(attempts):
        candidate = port + offset
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((host, candidate))
            return candidate
        except OSError:
            continue
        finally:
            probe.close()
    return port


def _parse_args(argv: List[str], cfg: Config) -> Dict[str, Any]:
    opts: Dict[str, Any] = {
        "host": cfg.web_host,
        "port": cfg.web_port,
        "session": cfg.default_session,
        "open": cfg.web_open not in ("never", "off", "false", "0"),
        "token": cfg.web_token,
        "force_token": False,
        "no_token": False,
        "cors": None,
        "spawn": True,
        "force_new": False,
        "fresh": False,
        "explicit": set(),
    }
    index = 0
    while index < len(argv):
        item = argv[index]
        nxt = argv[index + 1] if index + 1 < len(argv) else None
        if item in ("--session", "-s") and nxt:
            opts["session"] = nxt
            opts["explicit"].add("session")
            index += 2
            continue
        if item in ("--host", "--bind") and nxt:
            opts["host"] = nxt
            opts["explicit"].add("host")
            index += 2
            continue
        if item in ("--port", "-p") and nxt:
            try:
                opts["port"] = int(nxt)
                opts["explicit"].add("port")
            except ValueError:
                pass
            index += 2
            continue
        if item == "--token" and nxt:
            opts["token"] = nxt.strip()
            opts["force_token"] = True
            opts["explicit"].add("token")
            index += 2
            continue
        if item in ("--require-token", "--token-on"):
            opts["force_token"] = True
        elif item in ("--no-token", "--token-off"):
            opts["no_token"] = True
            opts["explicit"].add("token")
        elif item == "--cors":
            opts["cors"] = True
        elif item == "--no-cors":
            opts["cors"] = False
        elif item == "--open":
            opts["open"] = True
        elif item in ("--no-open", "--no-browser"):
            opts["open"] = False
        elif item == "--no-spawn":
            opts["spawn"] = False
        elif item in ("--force-new", "--new"):
            opts["force_new"] = True
        elif item in ("--fresh", "--reset", "--clear"):
            # 每次启动都从零开始：清掉该会话的历史与未读队列
            opts["fresh"] = True
        index += 1
    return opts


def run_web(cfg: Config, log: Log, argv: Optional[List[str]] = None) -> int:
    opts = _parse_args(list(argv or []), cfg)
    session = str(opts["session"] or cfg.default_session)
    host = str(opts["host"] or "127.0.0.1")

    # --fresh：把这个会话的历史与未读队列清干净，做到“每次开始都是新的”。
    if opts.get("fresh"):
        reset_session(cfg, log, session, spawn=bool(opts["spawn"]))

    # 已经有一个 Web 界面在跑（例如双击了两次启动脚本）：直接复用，开个新标签页即可。
    # 但如果这次显式指定了不同的端口/主机/令牌，说明用户想另起一个实例。
    explicit = opts.get("explicit") or set()
    reuse_allowed = not opts.get("force_new")
    if reuse_allowed:
        existing = find_running_web(cfg)
        if existing:
            if "port" in explicit and int(existing.get("port") or 0) != int(opts["port"]):
                reuse_allowed = False
            if "host" in explicit and str(existing.get("host") or "") != str(opts["host"]):
                reuse_allowed = False
            if "token" in explicit and str(existing.get("token") or "") != str(opts["token"] if not opts["no_token"] else ""):
                reuse_allowed = False
        if existing and reuse_allowed:
            url = existing["url"]
            if existing.get("token"):
                url += "?token=" + urllib.parse.quote(existing["token"])
            print("HumanChat Web 界面已经在运行：%s" % url, flush=True)
            if opts["open"]:
                webbrowser.open(url)
            return 0

    if opts["no_token"]:
        token = ""
    elif opts["force_token"]:
        token = str(opts["token"] or "") or secrets.token_urlsafe(18)
    elif opts["token"]:
        token = str(opts["token"])
    elif _is_loopback(host):
        token = ""
    else:
        token = secrets.token_urlsafe(18)
        log.info("监听非本机地址，已自动生成访问令牌")

    wanted = int(opts["port"] if opts["port"] is not None else cfg.web_port)
    port = _pick_port(host, wanted)
    hub = Hub(cfg, log, session=session, spawn=bool(opts["spawn"]))
    cors = opts["cors"] if opts["cors"] is not None else (not token)
    server = WebServer((host, port), Handler, hub, token, bool(cors))
    port = server.server_address[1]
    if wanted and port != wanted:
        log.warn("端口 %s 被占用，改用 %s" % (wanted, port))
    hub.start()

    base = "http://%s:%d/" % ("127.0.0.1" if host in ("0.0.0.0", "::") else host, port)
    local_url = base + (("?token=" + token) if token else "")
    lines = [
        "",
        "  HumanChat Web 界面已启动",
        "  ─────────────────────────────────────────────",
        "  会话      : %s" % session,
        "  本机地址  : %s" % local_url,
    ]
    if opts.get("fresh"):
        lines.append("  历史      : 已清空（--fresh）")
    if host in ("0.0.0.0", "::"):
        for ip in _lan_addresses():
            lines.append("  局域网    : http://%s:%d/%s" % (ip, port, ("?token=" + token) if token else ""))
    if token:
        lines.append("  访问令牌  : %s" % token)
    else:
        lines.append("  访问令牌  : 未启用（仅本机监听）")
    lines += [
        "  停止      : Ctrl+C",
        "",
    ]
    banner = "\n".join(lines)
    print(banner, flush=True)
    for line in lines:
        if line.strip():
            log.info("web：%s" % line.strip())

    _write_web_state(cfg, {
        "app": APP_ID,
        "pid": os.getpid(),
        "host": host,
        "port": port,
        "url": local_url,
        "token": token,
        "session": session,
        "started_at": time.time(),
        "version": __version__,
    })

    if opts["open"]:
        threading.Thread(
            target=lambda: (time.sleep(0.4), webbrowser.open(local_url)),
            name="webui-open",
            daemon=True,
        ).start()

    stop_signal = threading.Event()

    def _on_signal(signum, _frame):  # noqa: ANN001 - 标准库回调签名
        log.info("收到信号 %s，正在关闭 Web 界面" % signum)
        stop_signal.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, _on_signal)
        except (OSError, ValueError):
            pass

    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\n收到 Ctrl+C，正在关闭 …")
    finally:
        hub.stop()
        try:
            server.shutdown()
        except Exception:
            pass
        server.server_close()
        _clear_web_state(cfg, os.getpid())
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    """便于 ``python -m humanchat.webui`` 直接跑。"""
    cfg = Config()
    cfg.ensure_dirs()
    log = Log(cfg.broker_log, cfg.log_level, "webui")
    return run_web(cfg, log, argv)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
