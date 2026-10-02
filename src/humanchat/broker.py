"""Broker：会话、消息、等待队列，以及人类终端与 MCP 侧的共享通道。

一个 broker 进程通常是“MCP 服务器进程自己”（stdio 模式被 AgentDock 拉起时），
也可能是人类先手动启动的常驻进程（``humanchat-mcp --broker --daemon``）。
后启动的一方会自动探测已存在的 broker 并以客户端身份接入，避免状态分裂。

协议：换行分隔的 JSON（NDJSON）。

  请求: {"id": 1, "cmd": "send", "session": "default", "text": "..."}
  响应: {"id": 1, "ok": true, "data": {...}}
  事件: {"event": "message", "session": "default", "message": {...}}
"""

from __future__ import annotations

import errno
import json
import os
import socket
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from .config import Config
from .const import (
    KIND_DONE,
    KIND_ERROR,
    KIND_MESSAGE,
    KIND_NOTE,
    KIND_PROGRESS,
    KIND_QUESTION,
    ROLE_AGENT,
    ROLE_HUMAN,
    ROLE_SYSTEM,
    STATE_IDLE,
    STATE_WAITING,
    STATE_WORKING,
)

MAX_LINE_BYTES = 16 * 1024 * 1024


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
class Log:
    """极简日志：同时写 stderr 与文件；绝不会写到 stdout（stdio MCP 的命根子）。"""

    LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}

    def __init__(self, path=None, level: str = "info", name: str = "humanchat") -> None:
        self.path = path
        self.name = name
        self.level = self.LEVELS.get(str(level).lower(), 20)
        self._lock = threading.Lock()

    def _write(self, level: str, msg: str) -> None:
        if self.LEVELS.get(level, 20) < self.level:
            return
        line = "%s [%s] [%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), level.upper(), self.name, msg)
        with self._lock:
            try:
                import sys

                sys.stderr.write(line + "\n")
                sys.stderr.flush()
            except Exception:
                pass
            if self.path:
                try:
                    with open(self.path, "a", encoding="utf-8") as handle:
                        handle.write(line + "\n")
                except Exception:
                    pass

    def debug(self, msg: str) -> None:
        self._write("debug", msg)

    def info(self, msg: str) -> None:
        self._write("info", msg)

    def warn(self, msg: str) -> None:
        self._write("warn", msg)

    def error(self, msg: str) -> None:
        self._write("error", msg)


# ---------------------------------------------------------------------------
# 会话
# ---------------------------------------------------------------------------
class Session:
    def __init__(self, session_id: str, title: str = "", created_at: Optional[float] = None) -> None:
        self.id = session_id
        self.title = title or ""
        self.created_at = created_at or time.time()
        self.updated_at = self.created_at
        self.seq = 0
        self.messages: List[dict] = []
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.status: Dict[str, Any] = {
            "state": STATE_IDLE,
            "since": time.time(),
            "reason": "",
            "hint": "",
            "session_id": session_id,
        }

    # -- 消息 ---------------------------------------------------------------
    def add_message(
        self,
        role: str,
        text: str,
        kind: str = KIND_MESSAGE,
        meta: Optional[dict] = None,
    ) -> dict:
        with self.lock:
            self.seq += 1
            message = {
                "seq": self.seq,
                "ts": time.time(),
                "role": role,
                "kind": kind,
                "text": text,
                "session_id": self.id,
                "consumed": False,
                "meta": meta or {},
            }
            self.messages.append(message)
            self.updated_at = message["ts"]
            self.cond.notify_all()
            return message

    def pending_human(self) -> List[dict]:
        with self.lock:
            return [m for m in self.messages if m["role"] == ROLE_HUMAN and not m.get("consumed")]

    def pop_pending_human(self) -> Optional[dict]:
        """在 cond 锁内调用。"""
        for message in self.messages:
            if message["role"] == ROLE_HUMAN and not message.get("consumed"):
                message["consumed"] = True
                return message
        return None

    def tail(self, limit: int = 200, since: int = 0) -> List[dict]:
        with self.lock:
            if since:
                return [m for m in self.messages if m["seq"] > since]
            return self.messages[-limit:]

    def snapshot(self, limit: int = 200) -> dict:
        with self.lock:
            return {
                "id": self.id,
                "title": self.title,
                "created_at": self.created_at,
                "updated_at": self.updated_at,
                "seq": self.seq,
                "count": len(self.messages),
                "pending_human": len(self.pending_human()),
                "status": dict(self.status),
                "messages": self.messages[-limit:],
            }

    def summary(self) -> dict:
        with self.lock:
            last = self.messages[-1] if self.messages else None
            return {
                "id": self.id,
                "title": self.title,
                "created_at": self.created_at,
                "updated_at": self.updated_at,
                "count": len(self.messages),
                "pending_human": len(self.pending_human()),
                "state": self.status.get("state", STATE_IDLE),
                "preview": (last or {}).get("text", "")[:120],
                "preview_role": (last or {}).get("role", ""),
                "preview_ts": (last or {}).get("ts", 0),
            }


# ---------------------------------------------------------------------------
# 连接
# ---------------------------------------------------------------------------
class ClientConn:
    def __init__(self, conn: socket.socket, addr: str, log: Log) -> None:
        self.id = uuid.uuid4().hex[:8]
        self.sock = conn
        self.addr = addr
        self.log = log
        self.role = "unknown"
        self.client_name = ""
        self.session_id = ""
        self.connected_at = time.time()
        self.last_seen = time.time()
        self.alive = True
        self._send_lock = threading.Lock()
        self._file = conn.makefile("rwb", buffering=0)
        self.cancel_event = threading.Event()

    @property
    def is_human(self) -> bool:
        return self.role == ROLE_HUMAN

    def send_json(self, payload: dict) -> bool:
        if not self.alive:
            return False
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        with self._send_lock:
            try:
                self._file.write(data)
                return True
            except Exception:
                self.alive = False
                return False

    def send_event(self, event: str, **payload: Any) -> bool:
        body = {"event": event}
        body.update(payload)
        return self.send_json(body)

    def read_line(self) -> Optional[bytes]:
        try:
            line = self._file.readline()
        except Exception:
            return None
        if not line:
            return None
        self.last_seen = time.time()
        return line

    def close(self) -> None:
        self.alive = False
        self.cancel_event.set()
        try:
            self._file.close()
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Broker
# ---------------------------------------------------------------------------
class Broker:
    def __init__(self, cfg: Config, log: Optional[Log] = None) -> None:
        self.cfg = cfg
        self.log = log or Log(cfg.broker_log, cfg.log_level, "broker")
        self.cfg.ensure_dirs()

        self.pid = os.getpid()
        self.started_at = time.time()

        self._lock = threading.RLock()
        self.sessions: Dict[str, Session] = {}
        self.human_clients: Dict[str, ClientConn] = {}
        self.mcp_clients: Dict[str, ClientConn] = {}

        self.servers: List[socket.socket] = []
        self._stop = threading.Event()
        self._threads: List[threading.Thread] = []

        self.launch_attempts = 0
        self.last_launch_error = ""
        self.launched_hint = ""

        self._load_existing_sessions()

    # ---------------------------------------------------------------- 元信息
    def endpoint(self) -> str:
        return self.cfg.endpoint

    def info(self) -> dict:
        with self._lock:
            humans = [c for c in self.human_clients.values() if c.alive]
            mcps = [c for c in self.mcp_clients.values() if c.alive]
            return {
                "pid": self.pid,
                "started_at": self.started_at,
                "endpoint": self.endpoint(),
                "human_clients": len(humans),
                "human_client_names": [c.client_name or c.role for c in humans],
                "mcp_clients": len(mcps),
                "sessions": [s.summary() for s in self.sessions.values()],
                "session_count": len(self.sessions),
                "default_session": self.cfg.default_session,
                "keepalive_seconds": self.cfg.keepalive_seconds,
                "autolaunch": self.cfg.autolaunch,
                "version": self._version(),
                "launch_attempts": self.launch_attempts,
                "last_launch_error": self.last_launch_error,
            }

    @staticmethod
    def _version() -> str:
        try:
            from . import __version__

            return __version__
        except Exception:
            return "0"

    def human_attached(self) -> bool:
        with self._lock:
            return any(c.alive for c in self.human_clients.values())

    # ---------------------------------------------------------------- 会话
    def get_session(self, session_id: str = "", create: bool = True) -> Session:
        sid = (session_id or "").strip() or self.cfg.default_session
        with self._lock:
            session = self.sessions.get(sid)
            if session is None and create:
                session = Session(sid)
                self.sessions[sid] = session
                self.log.info("创建会话 %s" % sid)
                self._append_meta(session)
            if session is None:
                raise KeyError("session not found: %s" % sid)
            return session

    def list_sessions(self) -> List[dict]:
        with self._lock:
            items = [s.summary() for s in self.sessions.values()]
        items.sort(key=lambda item: item.get("updated_at", 0), reverse=True)
        return items

    # ---------------------------------------------------------------- 消息
    def append_message(
        self,
        session_id: str,
        role: str,
        text: str,
        kind: str = KIND_MESSAGE,
        meta: Optional[dict] = None,
    ) -> dict:
        session = self.get_session(session_id)
        message = session.add_message(role, text, kind, meta)
        self._persist_message(session, message)
        self.broadcast(
            "message",
            session=session.id,
            message=message,
            only_humans=(role == ROLE_AGENT),
        )
        if role == ROLE_AGENT:
            self.broadcast("agent_message", session=session.id, message=message)
        return message

    def broadcast(self, event: str, only_humans: bool = True, **payload: Any) -> None:
        with self._lock:
            targets = [c for c in self.human_clients.values() if c.alive]
        for conn in targets:
            if not conn.send_event(event, **payload):
                self._drop_client(conn)

    # ---------------------------------------------------------------- 状态
    def set_agent_status(
        self,
        session_id: str,
        state: str,
        reason: str = "",
        hint: str = "",
        since: Optional[float] = None,
    ) -> dict:
        session = self.get_session(session_id)
        with session.lock:
            session.status = {
                "state": state,
                "since": since if since is not None else time.time(),
                "reason": reason,
                "hint": hint,
                "session_id": session.id,
            }
            status = dict(session.status)
        self._append_meta(session)
        self.broadcast("status", session=session.id, status=status)
        return status

    # ---------------------------------------------------------------- 等待
    def wait_for_human(
        self,
        session_id: str,
        keepalive: float = 0.0,
        max_wait: float = 0.0,
        heartbeat: float = 15.0,
        on_heartbeat: Optional[Callable[[float], None]] = None,
        on_keepalive: Optional[Callable[[float], None]] = None,
        cancel: Optional[threading.Event] = None,
        reason: str = "",
        hint: str = "",
        wait_started_at: Optional[float] = None,
    ) -> Tuple[str, Any]:
        """等待人类的下一条消息。

        返回 (status, payload)：

          ("message",  <message>)     收到人类消息
          ("keepalive", elapsed)      到 keepalive 时间点仍无消息 —— 调用方应让 Agent 立刻重试
          ("timeout",  elapsed)       达到 max_wait（显式上限）
          ("cancelled", elapsed)      客户端取消 / 连接断开
        """
        session = self.get_session(session_id)
        start = wait_started_at or time.time()
        last_beat = time.time()
        self.set_agent_status(session.id, STATE_WAITING, reason=reason, hint=hint, since=start)
        try:
            while True:
                with session.cond:
                    message = session.pop_pending_human()
                    if message is not None:
                        return ("message", message)
                    now = time.time()
                    if max_wait and (now - start) >= max_wait:
                        return ("timeout", now - start)
                    if keepalive and (now - start) >= keepalive:
                        return ("keepalive", now - start)

                    deadlines = [now + 0.25]
                    if keepalive:
                        deadlines.append(start + keepalive)
                    if max_wait:
                        deadlines.append(start + max_wait)
                    if heartbeat and on_heartbeat:
                        deadlines.append(last_beat + heartbeat)
                    wait_for = max(0.05, min(deadlines) - now)
                    session.cond.wait(timeout=wait_for)

                now = time.time()
                if cancel is not None and cancel.is_set():
                    return ("cancelled", now - start)
                if heartbeat and on_heartbeat and (now - last_beat) >= heartbeat:
                    last_beat = now
                    try:
                        on_heartbeat(now - start)
                    except Exception as exc:  # 通知失败不影响等待
                        self.log.debug("心跳回调异常: %r" % (exc,))
                if on_keepalive is not None and keepalive and (now - start) >= keepalive:
                    on_keepalive(now - start)
        finally:
            self.set_agent_status(session.id, STATE_WORKING, since=time.time())

    # ---------------------------------------------------------------- 服务器
    def start(self) -> None:
        """绑定监听地址。若已有存活 broker，抛 ConnectionError（调用方改走远程模式）。"""
        cfg = self.cfg
        if cfg.use_tcp:
            # 先探测：Windows 上两个进程可以同时绑同一个端口（见下方 SO_REUSEADDR 说明），
            # 不探测就会出现两个 broker 抢同一个端口，人类终端和 Agent 各连一个 → 消息丢失。
            if probe_endpoint(cfg.endpoint, cfg.token or None, timeout=0.6):
                raise ConnectionError("another humanchat broker is already listening on %s" % cfg.endpoint)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            # SO_REUSEADDR 只在 POSIX 上用于快速重启（TIME_WAIT）；Windows 上它允许
            # 第二个进程抢占同一端口，所以那里必须关掉。
            if os.name != "nt":
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((cfg.tcp_host, cfg.tcp_port))
        else:
            path = cfg.socket_path
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                if probe_endpoint(str(path), None, timeout=0.6):
                    raise ConnectionError("another humanchat broker is already listening on %s" % path)
                try:
                    path.unlink()
                except OSError:
                    pass
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.bind(str(path))
            try:
                os.chmod(str(path), 0o600)
            except OSError:
                pass
        sock.listen(64)
        sock.settimeout(0.5)
        self.servers.append(sock)
        self._write_broker_json()
        self.log.info("broker 已监听 %s" % self.endpoint())

        thread = threading.Thread(target=self._accept_loop, name="broker-accept", daemon=True)
        thread.start()
        self._threads.append(thread)

    def _accept_loop(self) -> None:
        while not self._stop.is_set():
            for server in list(self.servers):
                try:
                    conn, addr = server.accept()
                except socket.timeout:
                    continue
                except OSError:
                    continue
                if isinstance(addr, tuple):
                    addr_str = "%s:%s" % (addr[0], addr[1])
                else:
                    addr_str = str(addr)
                try:
                    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except OSError:
                    pass
                client = ClientConn(conn, addr_str, self.log)
                thread = threading.Thread(
                    target=self._client_loop,
                    args=(client,),
                    name="broker-client-%s" % client.id,
                    daemon=True,
                )
                thread.start()
                self._threads.append(thread)

    def _drop_client(self, client: ClientConn) -> None:
        with self._lock:
            self.human_clients.pop(client.id, None)
            self.mcp_clients.pop(client.id, None)
        client.close()

    def _client_loop(self, client: ClientConn) -> None:
        self.log.debug("客户端接入 %s" % client.addr)
        try:
            while not self._stop.is_set() and client.alive:
                line = client.read_line()
                if line is None:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    request = json.loads(line.decode("utf-8"))
                except Exception:
                    client.send_json({"ok": False, "error": {"code": "bad_json", "message": "invalid JSON"}})
                    continue
                try:
                    response = self.handle_command(client, request)
                except Exception as exc:
                    self.log.warn("命令处理失败: %r" % (exc,))
                    response = {"ok": False, "error": {"code": "internal", "message": str(exc)}}
                if response is not None:
                    if "id" in request:
                        response["id"] = request["id"]
                    client.send_json(response)
        finally:
            self._drop_client(client)
            if client.is_human:
                self.broadcast("clients", humans=self.human_count())
            self.log.debug("客户端断开 %s" % client.addr)

    def human_count(self) -> int:
        with self._lock:
            return sum(1 for c in self.human_clients.values() if c.alive)

    # ---------------------------------------------------------------- 命令
    def handle_command(self, client: ClientConn, request: dict) -> Optional[dict]:
        cmd = str(request.get("cmd", "")).strip().lower()

        # 鉴权（可选）
        if self.cfg.token and cmd != "ping":
            supplied = str(request.get("token", "") or "")
            if supplied != self.cfg.token and client.role == "unknown":
                return {"ok": False, "error": {"code": "unauthorized", "message": "token required"}}

        if cmd == "ping":
            return {"ok": True, "data": {"pong": True, "version": self._version(), "pid": self.pid}}

        if cmd == "hello":
            role = str(request.get("role", ROLE_HUMAN)).strip().lower()
            client.role = ROLE_HUMAN if role == "human" else role
            client.client_name = str(request.get("client", "") or "")
            client.session_id = str(request.get("session", "") or "")
            if client.role == ROLE_HUMAN:
                with self._lock:
                    self.human_clients[client.id] = client
                self.broadcast("clients", humans=self.human_count())
            else:
                with self._lock:
                    self.mcp_clients[client.id] = client
            self.log.info("%s 已连接 (%s)" % (client.role, client.client_name or client.addr))
            return {
                "ok": True,
                "data": {
                    "client_id": client.id,
                    "server": self.info(),
                    "history": self.get_session(client.session_id).snapshot(),
                },
            }

        if cmd == "sessions":
            return {"ok": True, "data": {"sessions": self.list_sessions(), "default_session": self.cfg.default_session}}

        if cmd == "history":
            session = self.get_session(str(request.get("session", "")))
            return {"ok": True, "data": {"session": session.snapshot(limit=int(request.get("limit", 200) or 200))}}

        if cmd == "send":
            text = str(request.get("text", ""))
            session_id = str(request.get("session", "") or self.cfg.default_session)
            meta = request.get("meta") or {}
            message = self.append_message(session_id, ROLE_HUMAN, text, meta=meta)
            return {"ok": True, "data": {"message": message}}

        if cmd == "append":
            text = str(request.get("text", ""))
            session_id = str(request.get("session", "") or self.cfg.default_session)
            kind = str(request.get("kind", KIND_MESSAGE) or KIND_MESSAGE)
            meta = request.get("meta") or {}
            message = self.append_message(session_id, ROLE_AGENT, text, kind=kind, meta=meta)
            return {"ok": True, "data": {"message": message}}

        if cmd == "set_status":
            session_id = str(request.get("session", "") or self.cfg.default_session)
            status = self.set_agent_status(
                session_id,
                str(request.get("state", STATE_IDLE) or STATE_IDLE),
                reason=str(request.get("reason", "") or ""),
                hint=str(request.get("hint", "") or ""),
            )
            return {"ok": True, "data": {"status": status}}

        if cmd == "status":
            session_id = str(request.get("session", "") or self.cfg.default_session)
            session = self.get_session(session_id)
            consume = bool(request.get("consume"))
            with session.lock:
                status = dict(session.status)
                pending = [m for m in session.messages if m["role"] == ROLE_HUMAN and not m.get("consumed")]
                if consume:
                    for message in pending:
                        message["consumed"] = True
            return {
                "ok": True,
                "data": {
                    "status": status,
                    "pending_human": pending[-20:],
                    "pending_count": len(pending),
                    "human_attached": self.human_attached(),
                    "human_clients": self.human_count(),
                    "session": session.summary(),
                    "server": {"pid": self.pid, "endpoint": self.endpoint(), "started_at": self.started_at},
                },
            }

        if cmd == "new":
            session_id = str(request.get("session", "") or ("s-" + uuid.uuid4().hex[:6]))
            session = self.get_session(session_id)
            if request.get("title"):
                session.title = str(request["title"])
                self._append_meta(session)
            self.broadcast("sessions", sessions=self.list_sessions())
            return {"ok": True, "data": {"session": session.summary()}}

        if cmd == "rename":
            session = self.get_session(str(request.get("session", "")))
            session.title = str(request.get("title", "") or "")
            self._append_meta(session)
            self.broadcast("sessions", sessions=self.list_sessions())
            return {"ok": True, "data": {"session": session.summary()}}

        if cmd == "clear":
            session = self.get_session(str(request.get("session", "")))
            with session.lock:
                session.messages = []
                session.seq = 0
            self.cfg.session_file(session.id).write_text("", encoding="utf-8")
            self.broadcast("cleared", session=session.id)
            return {"ok": True, "data": {"session": session.summary()}}

        if cmd == "export":
            session = self.get_session(str(request.get("session", "")))
            path = str(request.get("path", "") or "")
            text = export_transcript(session)
            if path:
                try:
                    with open(os.path.expanduser(path), "w", encoding="utf-8") as handle:
                        handle.write(text)
                except OSError as exc:
                    return {"ok": False, "error": {"code": "io", "message": str(exc)}}
            return {"ok": True, "data": {"path": path, "text": text}}

        if cmd == "wait":
            return self._remote_wait(client, request)

        if cmd == "shutdown":
            self.log.info("收到 shutdown 请求，正在退出")
            threading.Thread(target=self.stop, name="broker-shutdown", daemon=True).start()
            return {"ok": True, "data": {"stopping": True}}

        return {"ok": False, "error": {"code": "unknown_command", "message": "unknown cmd: %s" % cmd}}

    def _remote_wait(self, client: ClientConn, request: dict) -> dict:
        """给远程 MCP 代理用的等待：过程中推送 wait_* 事件。"""
        session_id = str(request.get("session", "") or self.cfg.default_session)
        keepalive = float(request.get("keepalive_seconds", self.cfg.keepalive_seconds) or 0)
        max_wait = float(request.get("max_wait_seconds", 0) or 0)
        heartbeat = float(request.get("heartbeat_seconds", self.cfg.heartbeat_seconds) or 0)
        reason = str(request.get("reason", "") or "")
        hint = str(request.get("hint", "") or "")

        def on_heartbeat(elapsed: float) -> None:
            client.send_event("wait_progress", session=session_id, elapsed=elapsed)

        def on_keepalive(elapsed: float) -> None:
            client.send_event("wait_keepalive", session=session_id, elapsed=elapsed)

        status, payload = self.wait_for_human(
            session_id,
            keepalive=keepalive,
            max_wait=max_wait,
            heartbeat=heartbeat,
            on_heartbeat=on_heartbeat,
            on_keepalive=on_keepalive,
            cancel=client.cancel_event,
            reason=reason,
            hint=hint,
        )
        if status == "message":
            client.send_event("wait_message", session=session_id, message=payload)
            return {"ok": True, "data": {"status": "message", "message": payload}}
        return {"ok": True, "data": {"status": status, "elapsed": payload}}

    # ---------------------------------------------------------------- 持久化
    def _persist_message(self, session: Session, message: dict) -> None:
        try:
            with open(self.cfg.session_file(session.id), "a", encoding="utf-8") as handle:
                handle.write(json.dumps(message, ensure_ascii=False) + "\n")
        except OSError as exc:
            self.log.warn("写入会话失败: %r" % (exc,))
        if message["seq"] % 10 == 0 or message.get("kind") in (KIND_DONE, KIND_QUESTION, KIND_ERROR):
            self._append_meta(session)

    def _append_meta(self, session: Session) -> None:
        try:
            self.cfg.session_meta_file(session.id).write_text(
                json.dumps(session.summary(), ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass

    def _load_existing_sessions(self) -> None:
        for path in sorted(self.cfg.sessions_dir.glob("*.jsonl")):
            sid = path.stem
            title = ""
            meta_path = self.cfg.session_meta_file(sid)
            if meta_path.exists():
                try:
                    title = str(json.loads(meta_path.read_text(encoding="utf-8")).get("title", "") or "")
                except Exception:
                    title = ""
            session = Session(sid, title=title)
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    for line in handle:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            message = json.loads(line)
                        except Exception:
                            continue
                        session.messages.append(message)
                        session.seq = max(session.seq, int(message.get("seq", 0)))
                        session.updated_at = max(session.updated_at, float(message.get("ts", 0)))
            except OSError:
                continue
            # 重启后，未消费的人类消息仍然待处理 —— 这正是“永不丢失”的关键。
            with self._lock:
                self.sessions[sid] = session
        if self.sessions:
            self.log.info("载入 %d 个历史会话" % len(self.sessions))

    def _write_broker_json(self) -> None:
        data = {
            "pid": self.pid,
            "endpoint": self.endpoint(),
            "socket": None if self.cfg.use_tcp else str(self.cfg.socket_path),
            "tcp": {"host": self.cfg.tcp_host, "port": self.cfg.tcp_port} if self.cfg.use_tcp else None,
            "started_at": self.started_at,
            "version": self._version(),
            "home": str(self.cfg.home),
        }
        try:
            self.cfg.broker_json.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    # ---------------------------------------------------------------- 关闭
    def stop(self) -> None:
        self._stop.set()
        for server in self.servers:
            try:
                server.close()
            except OSError:
                pass
        with self._lock:
            clients = list(self.human_clients.values()) + list(self.mcp_clients.values())
        for client in clients:
            client.close()
        if not self.cfg.use_tcp:
            try:
                if self.cfg.socket_path.exists():
                    self.cfg.socket_path.unlink()
            except OSError:
                pass
        try:
            if self.cfg.broker_json.exists():
                data = json.loads(self.cfg.broker_json.read_text(encoding="utf-8"))
                if int(data.get("pid", 0)) == self.pid:
                    self.cfg.broker_json.unlink()
        except Exception:
            pass
        self.log.info("broker 已停止")


# ---------------------------------------------------------------------------
# 传输辅助
# ---------------------------------------------------------------------------
def connect(endpoint: str, timeout: float = 3.0) -> socket.socket:
    """按 endpoint 字符串建立连接（unix:// 或 tcp:// 或裸路径）。"""
    if endpoint.startswith("tcp://"):
        host_port = endpoint[len("tcp://") :]
        host, _, port = host_port.rpartition(":")
        sock = socket.create_connection((host or "127.0.0.1", int(port)), timeout=timeout)
    else:
        path = endpoint[len("unix://") :] if endpoint.startswith("unix://") else endpoint
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(path)
    sock.settimeout(None)
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        pass
    return sock


def probe_endpoint(endpoint: str, token: Optional[str] = None, timeout: float = 1.0) -> bool:
    """探测某个 endpoint 上是否有存活 broker。"""
    if endpoint.startswith("unix://") or not endpoint.startswith("tcp://"):
        path = endpoint[len("unix://") :] if endpoint.startswith("unix://") else endpoint
        if not os.path.exists(path):
            return False
    try:
        sock = connect(endpoint, timeout=timeout)
    except (OSError, ValueError):
        return False
    try:
        payload = {"id": 1, "cmd": "ping"}
        if token:
            payload["token"] = token
        sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        sock.settimeout(timeout)
        buffer = b""
        while b"\n" not in buffer:
            chunk = sock.recv(4096)
            if not chunk:
                return False
            buffer += chunk
        reply = json.loads(buffer.split(b"\n", 1)[0].decode("utf-8"))
        return bool(reply.get("ok"))
    except Exception:
        return False
    finally:
        try:
            sock.close()
        except OSError:
            pass


def find_endpoint(cfg: Config) -> Optional[str]:
    """找出当前可用的 broker endpoint：先看配置，再看 broker.json。"""
    candidates = [cfg.endpoint]
    try:
        if cfg.broker_json.exists():
            data = json.loads(cfg.broker_json.read_text(encoding="utf-8"))
            endpoint = data.get("endpoint")
            if endpoint and endpoint not in candidates:
                candidates.append(endpoint)
            if not cfg.use_tcp and data.get("socket"):
                text = "unix://%s" % data["socket"]
                if text not in candidates:
                    candidates.append(text)
            tcp = data.get("tcp") or {}
            if tcp.get("port"):
                text = "tcp://%s:%s" % (tcp.get("host", "127.0.0.1"), tcp["port"])
                if text not in candidates:
                    candidates.append(text)
    except Exception:
        pass
    for endpoint in candidates:
        if probe_endpoint(endpoint, cfg.token or None):
            return endpoint
    return None


def export_transcript(session: Session) -> str:
    lines = ["# HumanChat 会话记录 · %s" % session.id, "", "> %d 条消息" % len(session.messages), ""]
    for message in session.tail(limit=10**9):
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(message["ts"]))
        who = {"agent": "🤖 Agent", "human": "🧑 人类", "system": "⚙️ 系统"}.get(message["role"], message["role"])
        kind = message.get("kind", KIND_MESSAGE)
        lines.append("### %s · %s · %s" % (who, when, kind))
        lines.append("")
        lines.append(message["text"])
        lines.append("")
    return "\n".join(lines)
