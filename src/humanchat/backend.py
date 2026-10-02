"""MCP 侧与 broker 之间的后端抽象。

两种形态：
  * LocalBackend  —— 本进程就是 broker（AgentDock 以 stdio 拉起 MCP 时的常见情况）。
  * RemoteBackend —— 已经有一个常驻 broker（人类先启动了终端），本进程以客户端接入。

对上层（工具实现）来说两者完全一致。
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import launcher
from .broker import Broker, Log, connect, find_endpoint
from .config import Config
from .const import (
    KIND_DONE,
    KIND_MESSAGE,
    ROLE_AGENT,
    ROLE_HUMAN,
    STATE_IDLE,
    STATE_WAITING,
    STATE_WORKING,
)


class BackendError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# 后端
# ---------------------------------------------------------------------------
class BaseBackend:
    mode = "base"

    def append_message(self, session_id: str, text: str, kind: str, meta: Optional[dict] = None) -> dict:
        raise NotImplementedError

    def wait_for_human(
        self,
        session_id: str,
        keepalive: float,
        max_wait: float,
        heartbeat: float,
        on_heartbeat: Optional[Callable[[float], None]] = None,
        on_keepalive: Optional[Callable[[float], None]] = None,
        cancel: Optional[threading.Event] = None,
        reason: str = "",
        hint: str = "",
    ) -> Tuple[str, Any]:
        raise NotImplementedError

    def status(self, session_id: str, consume: bool = False) -> dict:
        raise NotImplementedError

    def set_agent_status(self, session_id: str, state: str, reason: str = "", hint: str = "") -> dict:
        raise NotImplementedError

    def human_attached(self) -> bool:
        raise NotImplementedError

    def info(self) -> dict:
        raise NotImplementedError

    def close(self) -> None:
        pass


class LocalBackend(BaseBackend):
    mode = "local"

    def __init__(self, broker: Broker) -> None:
        self.broker = broker

    def append_message(self, session_id: str, text: str, kind: str, meta: Optional[dict] = None) -> dict:
        return self.broker.append_message(session_id, ROLE_AGENT, text, kind=kind, meta=meta)

    def wait_for_human(self, session_id: str, keepalive: float, max_wait: float, heartbeat: float, **kwargs: Any) -> Tuple[str, Any]:
        return self.broker.wait_for_human(
            session_id,
            keepalive=keepalive,
            max_wait=max_wait,
            heartbeat=heartbeat,
            on_heartbeat=kwargs.get("on_heartbeat"),
            on_keepalive=kwargs.get("on_keepalive"),
            cancel=kwargs.get("cancel"),
            reason=kwargs.get("reason", ""),
            hint=kwargs.get("hint", ""),
        )

    def status(self, session_id: str, consume: bool = False) -> dict:
        session = self.broker.get_session(session_id)
        with session.lock:
            pending = [m for m in session.messages if m["role"] == ROLE_HUMAN and not m.get("consumed")]
            if consume:
                for message in pending:
                    message["consumed"] = True
            status = dict(session.status)
        return {
            "status": status,
            "pending_human": pending[-20:],
            "pending_count": len(pending),
            "human_attached": self.broker.human_attached(),
            "human_clients": self.broker.human_count(),
            "session": session.summary(),
            "server": {"pid": self.broker.pid, "endpoint": self.broker.endpoint(), "started_at": self.broker.started_at},
        }

    def set_agent_status(self, session_id: str, state: str, reason: str = "", hint: str = "") -> dict:
        return self.broker.set_agent_status(session_id, state, reason=reason, hint=hint)

    def human_attached(self) -> bool:
        return self.broker.human_attached()

    def info(self) -> dict:
        return self.broker.info()

    def close(self) -> None:
        self.broker.stop()


class RemoteBackend(BaseBackend):
    """连到已存在的 broker。等待使用独立连接，避免阻塞主连接。"""

    mode = "remote"

    def __init__(self, cfg: Config, endpoint: str, log: Log) -> None:
        self.cfg = cfg
        self.log = log
        self.endpoint = endpoint
        self._lock = threading.Lock()
        self._sock: Optional[socket.socket] = None
        self._file = None
        self._connect()

    def _connect(self) -> None:
        last_error: Optional[Exception] = None
        for _ in range(3):
            try:
                self._sock = connect(self.endpoint, timeout=3.0)
                self._file = self._sock.makefile("rwb", buffering=0)
                self._request("hello", role="mcp", client="humanchat-mcp")
                self.log.info("已接入现有 broker: %s" % self.endpoint)
                return
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                time.sleep(0.2)
        raise BackendError("无法连接 broker %s: %r" % (self.endpoint, last_error))

    def _request(self, cmd: str, **payload: Any) -> dict:
        with self._lock:
            if self._sock is None:
                self._connect()
            assert self._file is not None
            request_id = uuid.uuid4().hex[:8]
            body = {"id": request_id, "cmd": cmd}
            if self.cfg.token:
                body["token"] = self.cfg.token
            body.update(payload)
            try:
                self._file.write((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
            except Exception as exc:
                self._sock = None
                raise BackendError("写入 broker 失败: %r" % (exc,))
            while True:
                try:
                    line = self._file.readline()
                except Exception as exc:
                    self._sock = None
                    raise BackendError("读取 broker 失败: %r" % (exc,))
                if not line:
                    self._sock = None
                    raise BackendError("broker 连接已关闭")
                try:
                    message = json.loads(line.decode("utf-8"))
                except Exception:
                    continue
                if message.get("event"):
                    continue  # 主连接上的事件（例如别人的消息）在这里忽略
                if message.get("id") != request_id:
                    continue
                if not message.get("ok"):
                    error = message.get("error") or {}
                    raise BackendError(error.get("message", "broker 错误"))
                return message.get("data") or {}

    def append_message(self, session_id: str, text: str, kind: str, meta: Optional[dict] = None) -> dict:
        data = self._request("append", session=session_id, text=text, kind=kind, meta=meta or {})
        return data.get("message") or {}

    def set_agent_status(self, session_id: str, state: str, reason: str = "", hint: str = "") -> dict:
        data = self._request("set_status", session=session_id, state=state, reason=reason, hint=hint)
        return data.get("status") or {}

    def status(self, session_id: str, consume: bool = False) -> dict:
        return self._request("status", session=session_id, consume=consume)

    def human_attached(self) -> bool:
        try:
            return bool(self.status("").get("human_attached"))
        except BackendError:
            return False

    def info(self) -> dict:
        data = self._request("sessions")
        data["mode"] = "remote"
        data["endpoint"] = self.endpoint
        return data

    def wait_for_human(
        self,
        session_id: str,
        keepalive: float,
        max_wait: float,
        heartbeat: float,
        on_heartbeat: Optional[Callable[[float], None]] = None,
        on_keepalive: Optional[Callable[[float], None]] = None,
        cancel: Optional[threading.Event] = None,
        reason: str = "",
        hint: str = "",
    ) -> Tuple[str, Any]:
        sock = connect(self.endpoint, timeout=3.0)
        sock.settimeout(0.5)
        handle = sock.makefile("rwb", buffering=0)
        request_id = uuid.uuid4().hex[:8]
        payload = {
            "id": request_id,
            "cmd": "wait",
            "session": session_id,
            "keepalive_seconds": keepalive,
            "max_wait_seconds": max_wait,
            "heartbeat_seconds": heartbeat,
            "reason": reason,
            "hint": hint,
        }
        if self.cfg.token:
            payload["token"] = self.cfg.token
        try:
            handle.write((json.dumps({"id": uuid.uuid4().hex[:8], "cmd": "hello", "role": "mcp",
                                      "token": self.cfg.token or None, "client": "humanchat-mcp-wait"}) + "\n").encode("utf-8"))
            handle.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
            buffer = b""
            while True:
                if cancel is not None and cancel.is_set():
                    return ("cancelled", 0.0)
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    continue
                except OSError:
                    return ("cancelled", 0.0)
                if not chunk:
                    return ("cancelled", 0.0)
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        message = json.loads(line.decode("utf-8"))
                    except Exception:
                        continue
                    event = message.get("event")
                    if event == "wait_progress":
                        if on_heartbeat:
                            _safe(on_heartbeat, float(message.get("elapsed", 0)))
                        continue
                    if event == "wait_keepalive":
                        if on_keepalive:
                            _safe(on_keepalive, float(message.get("elapsed", 0)))
                        continue
                    if message.get("id") != request_id:
                        continue
                    if not message.get("ok"):
                        error = message.get("error") or {}
                        raise BackendError(error.get("message", "broker 等待失败"))
                    data = message.get("data") or {}
                    return (data.get("status", "keepalive"), data.get("message") if data.get("status") == "message" else data.get("elapsed", 0.0))
        finally:
            try:
                handle.close()
            except Exception:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def close(self) -> None:
        try:
            if self._file:
                self._file.close()
        except Exception:
            pass
        try:
            if self._sock:
                self._sock.close()
        except Exception:
            pass


def _safe(func: Callable[..., Any], *args: Any) -> None:
    try:
        func(*args)
    except Exception:
        pass


def create_backend(cfg: Config, log: Log) -> BaseBackend:
    endpoint = find_endpoint(cfg)
    if endpoint:
        try:
            return RemoteBackend(cfg, endpoint, log)
        except BackendError as exc:
            log.warn("接入现有 broker 失败，改为自行启动：%r" % (exc,))
    broker = Broker(cfg, log)
    try:
        broker.start()
    except ConnectionError:
        endpoint = find_endpoint(cfg)
        if endpoint:
            return RemoteBackend(cfg, endpoint, log)
        raise
    return LocalBackend(broker)


# ---------------------------------------------------------------------------
# 供 MCP 工具使用的服务层
# ---------------------------------------------------------------------------
class HandoffService:
    """把 broker / 终端拉起 / 人机交接语义包成一个对象。"""

    def __init__(self, cfg: Config, backend: BaseBackend, log: Log) -> None:
        self.cfg = cfg
        self.backend = backend
        self.log = log
        self._launch_lock = threading.Lock()
        self._launched = 0

    # ------------------------------------------------------------ 便捷方法
    @property
    def mode(self) -> str:
        return self.backend.mode

    def human_attached(self) -> bool:
        try:
            return self.backend.human_attached()
        except Exception:
            return False

    def info(self) -> dict:
        try:
            return self.backend.info()
        except Exception as exc:
            return {"error": str(exc), "mode": self.mode}

    def attach_command(self, session_id: str = "") -> str:
        """人类界面的接入命令（HUMANCHAT_UI=web 时给的是 Web 界面命令）。"""
        return launcher.ui_command(self.cfg, session_id or self.cfg.default_session)

    def ensure_human_terminal(
        self, reason: str = "", force: bool = False, session_id: str = ""
    ) -> dict:
        """按策略尝试拉起人类终端界面；返回尝试结果。"""
        session_id = session_id or self.cfg.default_session
        mode = self.cfg.autolaunch
        if mode in ("never", "off", "false", "0"):
            return {"attempted": False, "reason": "autolaunch disabled"}
        if self.human_attached() and not force:
            return {"attempted": False, "reason": "human already attached"}
        with self._launch_lock:
            if mode == "auto" and self._launched >= 1 and not force:
                return {
                    "attempted": False,
                    "reason": "already tried once",
                    "hint": self.attach_command(session_id),
                }
            self._launched += 1
            result = launcher.launch_terminal(
                self.cfg, reason=reason, log=self.log, session_id=session_id
            )
            if not result.get("ok"):
                self.cfg.attach_hint.write_text(self.attach_command(session_id), encoding="utf-8")
            return result

    # ------------------------------------------------------------ 消息
    def notify(
        self,
        text: str,
        kind: str = KIND_MESSAGE,
        session_id: str = "",
        meta: Optional[dict] = None,
        ensure_terminal: bool = True,
    ) -> dict:
        session_id = session_id or self.cfg.default_session
        if ensure_terminal:
            self.ensure_human_terminal(reason="agent notified the human", session_id=session_id)
        message = self.backend.append_message(session_id, text, kind, meta)
        self.backend.set_agent_status(session_id, STATE_WORKING)
        return message

    def wait(
        self,
        session_id: str = "",
        keepalive: Optional[float] = None,
        max_wait: float = 0.0,
        heartbeat: Optional[float] = None,
        on_heartbeat: Optional[Callable[[float], None]] = None,
        on_keepalive: Optional[Callable[[float], None]] = None,
        cancel: Optional[threading.Event] = None,
        reason: str = "",
        hint: str = "",
        ensure_terminal: bool = True,
    ) -> Tuple[str, Any]:
        session_id = session_id or self.cfg.default_session
        if keepalive is None:
            keepalive = self.cfg.keepalive_seconds
        if heartbeat is None:
            heartbeat = self.cfg.heartbeat_seconds
        if ensure_terminal:
            self.ensure_human_terminal(
                reason=reason or "agent is waiting for a human reply", session_id=session_id
            )
        return self.backend.wait_for_human(
            session_id,
            keepalive=keepalive,
            max_wait=max_wait,
            heartbeat=heartbeat,
            on_heartbeat=on_heartbeat,
            on_keepalive=on_keepalive,
            cancel=cancel,
            reason=reason,
            hint=hint,
        )

    def status(self, session_id: str = "", consume: bool = False) -> dict:
        session_id = session_id or self.cfg.default_session
        try:
            data = self.backend.status(session_id, consume=consume)
        except Exception as exc:
            return {"error": str(exc)}
        data["mode"] = self.mode
        data["attach_command"] = self.attach_command(session_id)
        return data

    def close(self) -> None:
        try:
            self.backend.close()
        except Exception:
            pass
