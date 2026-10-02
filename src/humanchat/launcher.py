"""自动为人类打开一个终端界面（TUI）。

策略顺序（第一个成功者获胜）：
  1. HUMANCHAT_LAUNCH_CMD 里的自定义命令模板（{} 会被替换为启动命令）
  2. tmux（已在 tmux 里 / 有 tmux server 在跑 → new-window）
  3. macOS：Terminal.app / iTerm2（osascript）
  4. Linux/BSD：常见终端模拟器（需要 DISPLAY 或 WAYLAND_DISPLAY）
  5. Windows：wt.exe / cmd start
失败时把 attach 命令写到 ~/.humanchat/attach.txt，并告诉 Agent，让它转告人类。
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import Config
from .broker import Log


def repo_root() -> Optional[Path]:
    try:
        root = Path(__file__).resolve().parents[2]
    except IndexError:
        return None
    if (root / "humanchat_mcp.py").exists():
        return root
    return None


def python_executable() -> str:
    return os.environ.get("HUMANCHAT_PYTHON", "").strip() or sys.executable or "python3"


def cli_argv(cfg: Config, session_id: str = "", extra: Optional[List[str]] = None) -> List[str]:
    """构造“启动人类终端界面”的 argv。"""
    python = python_executable()
    root = repo_root()
    args: List[str] = []
    if root is not None:
        args = [python, str(root / "humanchat_mcp.py")]
    else:
        args = [python, "-m", "humanchat"]
    args.append("attach")
    if session_id:
        args += ["--session", session_id]
    if extra:
        args += list(extra)
    return args


def cli_command(cfg: Config, session_id: str = "", extra: Optional[List[str]] = None) -> str:
    return " ".join(shlex.quote(part) for part in cli_argv(cfg, session_id, extra))


def web_argv(cfg: Config, session_id: str = "", extra: Optional[List[str]] = None) -> List[str]:
    """构造“启动 Web 界面”的 argv（自带 --open，由它负责叫浏览器）。"""
    python = python_executable()
    root = repo_root()
    args: List[str] = []
    if root is not None:
        args = [python, str(root / "humanchat_mcp.py")]
    else:
        args = [python, "-m", "humanchat"]
    args.append("web")
    if session_id:
        args += ["--session", session_id]
    if cfg.web_host:
        args += ["--host", cfg.web_host]
    if cfg.web_port:
        args += ["--port", str(cfg.web_port)]
    if cfg.web_open not in ("never", "off", "false", "0"):
        args.append("--open")
    else:
        args.append("--no-open")
    if extra:
        args += list(extra)
    return args


def web_command(cfg: Config, session_id: str = "", extra: Optional[List[str]] = None) -> str:
    return " ".join(shlex.quote(part) for part in web_argv(cfg, session_id, extra))


def ui_argv(cfg: Config, session_id: str = "", extra: Optional[List[str]] = None) -> List[str]:
    """按 HUMANCHAT_UI 选择人类界面形态（tui / web）。"""
    if getattr(cfg, "ui", "tui") == "web":
        return web_argv(cfg, session_id, extra)
    return cli_argv(cfg, session_id, extra)


def ui_command(cfg: Config, session_id: str = "", extra: Optional[List[str]] = None) -> str:
    return " ".join(shlex.quote(part) for part in ui_argv(cfg, session_id, extra))


def _spawn(argv: List[str]) -> None:
    kwargs: Dict[str, Any] = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "stdin": subprocess.DEVNULL}
    if os.name == "nt":  # pragma: no cover - Windows
        kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(argv, **kwargs)  # noqa: S603


def _run(argv: List[str], timeout: float = 6.0) -> bool:
    try:
        result = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
        return result.returncode == 0
    except Exception:
        return False


def _which(name: str) -> Optional[str]:
    return shutil.which(name)


def _is_macos() -> bool:
    return sys.platform == "darwin"


def _is_windows() -> bool:
    return os.name == "nt"


def launch_terminal(
    cfg: Config, reason: str = "", log: Optional[Log] = None, session_id: str = ""
) -> dict:
    log = log or Log()
    # 必须用调用方（Agent）的会话 id：写死 "default" 会让自动打开的界面挂到另一个会话，
    # 人类和 Agent 各说各话（消息看起来发出去了，对方永远收不到）。
    session_id = session_id or cfg.default_session
    command = ui_command(cfg, session_id)
    attempts: List[str] = []

    def fail(detail: str) -> dict:
        log.warn("自动打开人类界面失败: %s" % detail)
        return {"ok": False, "command": command, "attempts": attempts, "detail": detail}

    # 0) Web 界面：不需要终端模拟器，起一个本地 HTTP 服务并让系统浏览器打开
    if getattr(cfg, "ui", "tui") == "web":
        attempts.append("web")
        try:
            _spawn(web_argv(cfg, session_id))
            log.info("已在后台启动 Web 界面（浏览器随后自动打开）")
            time.sleep(0.4)
            return {"ok": True, "strategy": "web", "command": command, "attempts": attempts}
        except Exception as exc:  # noqa: BLE001 - 退回到终端界面
            log.warn("启动 Web 界面失败，改用终端界面: %r" % (exc,))
            command = cli_command(cfg, session_id)
            attempts.append("web-failed")

    # 1) 自定义模板
    if cfg.launch_cmd:
        rendered = cfg.launch_cmd.replace("{}", command)
        attempts.append("env:" + cfg.launch_cmd)
        if _run(["sh", "-c", rendered]):
            log.info("已通过 HUMANCHAT_LAUNCH_CMD 打开终端")
            return {"ok": True, "strategy": "env", "command": command, "attempts": attempts}
        return fail("HUMANCHAT_LAUNCH_CMD 执行失败: %s" % cfg.launch_cmd)

    # 2) tmux
    tmux = _which("tmux")
    if tmux:
        attempts.append("tmux")
        if os.environ.get("TMUX") or _run([tmux, "has-session"]):
            # -d: 不抢当前焦点；用户切换窗口即可看到
            if _run([tmux, "new-window", "-d", "-n", "humanchat", command]):
                log.info("已在 tmux 新窗口打开 humanchat")
                return {"ok": True, "strategy": "tmux", "command": command, "attempts": attempts}
            if _run([tmux, "split-window", "-d", "-h", command]):
                log.info("已在 tmux 新分屏打开 humanchat")
                return {"ok": True, "strategy": "tmux-split", "command": command, "attempts": attempts}

    # 3) macOS
    if _is_macos():
        attempts.append("osascript-terminal")
        script = 'tell application "Terminal" to do script "%s"' % command.replace('"', '\\"')
        if _run(["osascript", "-e", script, "-e", 'tell application "Terminal" to activate']):
            return {"ok": True, "strategy": "macos-terminal", "command": command, "attempts": attempts}
        if _which("osascript") and _which("open"):
            attempts.append("open-terminal")
            if _run(["open", "-a", "Terminal", str(Path(os.environ.get("SHELL", "/bin/zsh")))]):
                return {"ok": True, "strategy": "macos-open", "command": command, "attempts": attempts}

    # 4) Linux / BSD 终端模拟器
    has_display = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    if not _is_windows() and not _is_macos() and has_display:
        terminals = [
            ("x-terminal-emulator", ["-e"]),
            ("gnome-terminal", ["--"]),
            ("konsole", ["-e"]),
            ("xfce4-terminal", ["-e"]),
            ("mate-terminal", ["-e"]),
            ("alacritty", ["-e"]),
            ("kitty", []),
            ("wezterm", ["start", "--"]),
            ("foot", []),
            ("urxvt", ["-e"]),
            ("xterm", ["-e"]),
        ]
        for name, prefix in terminals:
            path = _which(name)
            if not path:
                continue
            attempts.append(name)
            argv = [path] + prefix + shlex.split(command)
            _spawn(argv)
            time.sleep(0.35)
            return {"ok": True, "strategy": name, "command": command, "attempts": attempts}

    # 5) Windows
    if _is_windows():
        attempts.append("windows-terminal")
        if _which("wt.exe") and _run(["wt.exe", "new-tab", "cmd", "/k", command]):
            return {"ok": True, "strategy": "wt", "command": command, "attempts": attempts}
        attempts.append("cmd-start")
        if _run(["cmd", "/c", "start", "", "cmd", "/k", command]):
            return {"ok": True, "strategy": "cmd-start", "command": command, "attempts": attempts}

    return fail("未找到可用的终端模拟器（可能是无图形界面的服务器 / 容器）")


def describe_environment() -> dict:
    return {
        "platform": sys.platform,
        "python": python_executable(),
        "tmux": _which("tmux"),
        "in_tmux": bool(os.environ.get("TMUX")),
        "display": os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY") or "",
        "cwd": os.getcwd(),
    }
