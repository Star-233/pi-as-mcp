"""路径与环境变量配置。

所有可变位置都由环境变量控制，方便 AgentDock 的 stdio 注册直接
通过 env_from_env 传递，或在 Docker 里挂载目录。
"""

from __future__ import annotations

import os
import socket
from pathlib import Path
from typing import Optional

ENV_HOME = "HUMANCHAT_HOME"
ENV_SOCKET = "HUMANCHAT_SOCKET"
ENV_TCP = "HUMANCHAT_TCP"
ENV_TCP_HOST = "HUMANCHAT_TCP_HOST"
ENV_TCP_PORT = "HUMANCHAT_TCP_PORT"
ENV_TOKEN = "HUMANCHAT_TOKEN"
ENV_KEEPALIVE = "HUMANCHAT_KEEPALIVE_SECONDS"
ENV_HEARTBEAT = "HUMANCHAT_HEARTBEAT_SECONDS"
ENV_AUTOLAUNCH = "HUMANCHAT_AUTOLAUNCH"
ENV_LAUNCH_CMD = "HUMANCHAT_LAUNCH_CMD"
ENV_SESSION = "HUMANCHAT_SESSION"
ENV_HTTP_HOST = "HUMANCHAT_HTTP_HOST"
ENV_HTTP_PORT = "HUMANCHAT_HTTP_PORT"
ENV_LOG_LEVEL = "HUMANCHAT_LOG_LEVEL"
ENV_LANG = "HUMANCHAT_LANG"
ENV_UI = "HUMANCHAT_UI"
ENV_WEB_HOST = "HUMANCHAT_WEB_HOST"
ENV_WEB_PORT = "HUMANCHAT_WEB_PORT"
ENV_WEB_TOKEN = "HUMANCHAT_WEB_TOKEN"
ENV_WEB_OPEN = "HUMANCHAT_WEB_OPEN"


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "y", "on", "always", "auto")


class Config:
    """运行期配置快照。"""

    def __init__(self, home: Optional[str] = None) -> None:
        self.home = Path(os.path.expanduser(home or os.environ.get(ENV_HOME) or "~/.humanchat"))
        self.sessions_dir = self.home / "sessions"
        self.log_dir = self.home / "logs"
        self.broker_json = self.home / "broker.json"
        self.broker_log = self.log_dir / "broker.log"
        self.attach_hint = self.home / "attach.txt"

        sock = os.environ.get(ENV_SOCKET, "").strip()
        # 默认放到 home 下，路径必须短：macOS 的 AF_UNIX 限制约 104 字节。
        self.socket_path = Path(os.path.expanduser(sock)) if sock else (self.home / "broker.sock")

        self.use_tcp = _env_bool(ENV_TCP, False) or not hasattr(socket, "AF_UNIX")
        self.tcp_host = os.environ.get(ENV_TCP_HOST, "127.0.0.1").strip() or "127.0.0.1"
        self.tcp_port = _env_int(ENV_TCP_PORT, 8790)

        # 人类侧 / MCP 侧的共享令牌（可选）。为空表示只靠本机 socket 权限保护。
        self.token = os.environ.get(ENV_TOKEN, "").strip()

        # 默认 keepalive：240s < AgentDock 的 300s 上限，留出安全余量。
        # 0 表示真正永久阻塞（适用于没有单次调用上限的客户端）。
        self.keepalive_seconds = _env_float(ENV_KEEPALIVE, 240.0)
        self.heartbeat_seconds = _env_float(ENV_HEARTBEAT, 15.0)

        # auto | always | never
        self.autolaunch = (os.environ.get(ENV_AUTOLAUNCH, "auto").strip().lower() or "auto")
        self.launch_cmd = os.environ.get(ENV_LAUNCH_CMD, "").strip()

        self.default_session = os.environ.get(ENV_SESSION, "default").strip() or "default"

        self.http_host = os.environ.get(ENV_HTTP_HOST, "127.0.0.1").strip() or "127.0.0.1"
        self.http_port = _env_int(ENV_HTTP_PORT, 8791)

        self.log_level = (os.environ.get(ENV_LOG_LEVEL, "info").strip().lower() or "info")
        self.lang = (os.environ.get(ENV_LANG, "zh").strip().lower() or "zh")

        # 人类界面形态：tui（终端全屏界面，默认）| web（浏览器界面）
        # 影响“Agent 自动打开人类界面”和 attach_command 提示里给出的命令。
        ui = (os.environ.get(ENV_UI, "tui").strip().lower() or "tui")
        self.ui = "web" if ui in ("web", "webui", "browser", "http") else "tui"

        # Web 界面（humanchat web）
        self.web_host = os.environ.get(ENV_WEB_HOST, "127.0.0.1").strip() or "127.0.0.1"
        self.web_port = _env_int(ENV_WEB_PORT, 8792)
        # 为空时：仅本机监听不需要令牌；监听 0.0.0.0 等地址会自动生成
        self.web_token = os.environ.get(ENV_WEB_TOKEN, "").strip()
        # auto（默认打开浏览器）| never
        self.web_open = (os.environ.get(ENV_WEB_OPEN, "auto").strip().lower() or "auto")

    # ------------------------------------------------------------------ 工具
    def ensure_dirs(self) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)

    @property
    def endpoint(self) -> str:
        """人类 CLI / MCP 代理连接 broker 用的地址字符串。"""
        if self.use_tcp:
            return "tcp://%s:%d" % (self.tcp_host, self.tcp_port)
        return "unix://%s" % self.socket_path

    def session_file(self, session_id: str) -> Path:
        safe = "".join(ch if (ch.isalnum() or ch in "-_.") else "_" for ch in session_id) or "default"
        return self.sessions_dir / (safe + ".jsonl")

    def session_meta_file(self, session_id: str) -> Path:
        safe = "".join(ch if (ch.isalnum() or ch in "-_.") else "_" for ch in session_id) or "default"
        return self.sessions_dir / (safe + ".meta.json")

    def describe(self) -> dict:
        return {
            "home": str(self.home),
            "endpoint": self.endpoint,
            "socket": None if self.use_tcp else str(self.socket_path),
            "tcp": {"host": self.tcp_host, "port": self.tcp_port} if self.use_tcp else None,
            "auth": bool(self.token),
            "keepalive_seconds": self.keepalive_seconds,
            "heartbeat_seconds": self.heartbeat_seconds,
            "autolaunch": self.autolaunch,
            "default_session": self.default_session,
            "ui": self.ui,
            "web": {"host": self.web_host, "port": self.web_port, "token": bool(self.web_token)},
        }
