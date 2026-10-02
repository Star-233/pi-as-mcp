"""人类侧的终端界面（TUI）与命令行工具。

用法：
  humanchat attach                 # 打开全屏终端界面（推荐）
  humanchat attach --simple        # 极简逐行模式（非 tty / 远程 ssh 场景）
  humanchat send "继续"            # 单条发送，不进入界面
  humanchat status / sessions      # 查看状态
  humanchat quit-broker            # 停止常驻 broker

界面快捷键：
  Enter 发送 · Ctrl+J / Alt+Enter 换行 · ↑↓/PgUp/PgDn 滚动 · Tab 切换会话
  Ctrl+P / Ctrl+N 输入历史 · Ctrl+L 重绘 · F1 或 ? 帮助 · Ctrl+C 退出
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from typing import Any, Dict, List, Optional, Tuple

from .broker import Log, connect, find_endpoint
from .config import Config
from .const import KIND_DONE, KIND_ERROR, KIND_NOTE, KIND_PROGRESS, KIND_QUESTION

VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# 终端宽度（CJK 算 2 列）
# ---------------------------------------------------------------------------
def _char_width(ch: str) -> int:
    if ch == "\t":
        return 4
    if unicodedata.combining(ch):
        return 0
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    if ord(ch) < 32:
        return 0
    return 1


def display_width(text: str) -> int:
    return sum(_char_width(ch) for ch in text)


def truncate(text: str, width: int) -> str:
    if width <= 0:
        return ""
    out = []
    used = 0
    for ch in text:
        w = _char_width(ch)
        if used + w > width:
            break
        out.append(ch)
        used += w
    return "".join(out)


def wrap_text(text: str, width: int) -> List[str]:
    """按显示宽度换行，保留显式换行。"""
    if width <= 1:
        return [text]
    lines: List[str] = []
    for raw_line in text.split("\n"):
        if raw_line == "":
            lines.append("")
            continue
        current = ""
        used = 0
        for ch in raw_line:
            w = _char_width(ch)
            if used + w > width:
                lines.append(current)
                current = ch
                used = w
            else:
                current += ch
                used += w
        lines.append(current)
    return lines


class Style:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled and os.environ.get("NO_COLOR", "") == ""

    def _wrap(self, text: str, *codes: str) -> str:
        if not self.enabled:
            return text
        return "\x1b[" + ";".join(codes) + "m" + text + "\x1b[0m"

    def dim(self, text: str) -> str:
        return self._wrap(text, "2")

    def bold(self, text: str) -> str:
        return self._wrap(text, "1")

    def red(self, text: str) -> str:
        return self._wrap(text, "31")

    def green(self, text: str) -> str:
        return self._wrap(text, "32")

    def yellow(self, text: str) -> str:
        return self._wrap(text, "33")

    def blue(self, text: str) -> str:
        return self._wrap(text, "34")

    def magenta(self, text: str) -> str:
        return self._wrap(text, "35")

    def cyan(self, text: str) -> str:
        return self._wrap(text, "36")

    def grey(self, text: str) -> str:
        return self._wrap(text, "90")

    def reverse(self, text: str) -> str:
        return self._wrap(text, "7")

    def bg_blue(self, text: str) -> str:
        return self._wrap(text, "44", "97")


# ---------------------------------------------------------------------------
# broker 客户端
# ---------------------------------------------------------------------------
class BrokerClient:
    """线程安全地连接 broker：请求/响应 + 事件推送。"""

    def __init__(self, cfg: Config, endpoint: str, role: str = "human", client_name: str = "humanchat-tui") -> None:
        self.cfg = cfg
        self.endpoint = endpoint
        self.role = role
        self.client_name = client_name
        self.events: "queue.Queue[dict]" = queue.Queue()
        self._pending: Dict[str, "queue.Queue[dict]"] = {}
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._sock: Optional[socket.socket] = None
        self._file = None
        self._stop = threading.Event()
        self.hello: Dict[str, Any] = {}
        self.connected = False
        self.last_error = ""

    # -- 连接 -------------------------------------------------------------
    def connect(self, session: str = "") -> dict:
        self._sock = connect(self.endpoint, timeout=5.0)
        self._file = self._sock.makefile("rwb", buffering=0)
        thread = threading.Thread(target=self._read_loop, name="broker-reader", daemon=True)
        thread.start()
        self.hello = self.request("hello", role=self.role, client=self.client_name, session=session)
        self.connected = True
        return self.hello

    def close(self) -> None:
        self._stop.set()
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
        self.connected = False

    def _fail_pending(self, message: str) -> None:
        """连接断掉时，让所有还在等回包的请求立刻失败（而不是各自干等到超时）。"""
        with self._lock:
            boxes = list(self._pending.values())
            self._pending.clear()
        for box in boxes:
            box.put({"ok": False, "error": {"code": "disconnected", "message": message}})

    def _read_loop(self) -> None:
        assert self._file is not None
        while not self._stop.is_set():
            try:
                line = self._file.readline()
            except Exception:
                break
            if not line:
                break
            try:
                message = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            if "event" in message:
                self.events.put(message)
                continue
            request_id = str(message.get("id"))
            with self._lock:
                box = self._pending.get(request_id)
            if box is not None:
                box.put(message)
        if not self._stop.is_set():
            self._fail_pending("broker 连接已断开")
        self.connected = False
        self.events.put({"event": "disconnected"})

    # -- 请求 -------------------------------------------------------------
    def request(self, cmd: str, timeout: Optional[float] = 15.0, **payload: Any) -> dict:
        if self._file is None:
            raise RuntimeError("未连接 broker")
        request_id = uuid.uuid4().hex[:8]
        box: "queue.Queue[dict]" = queue.Queue()
        with self._lock:
            self._pending[request_id] = box
        body = {"id": request_id, "cmd": cmd}
        if self.cfg.token:
            body["token"] = self.cfg.token
        body.update(payload)
        try:
            with self._write_lock:
                self._file.write((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
        except Exception as exc:
            with self._lock:
                self._pending.pop(request_id, None)
            self._fail_pending("broker 连接已断开")
            raise RuntimeError("发送失败: %r" % (exc,))
        try:
            response = box.get(timeout=timeout) if timeout else box.get()
        except queue.Empty:
            with self._lock:
                self._pending.pop(request_id, None)
            raise TimeoutError("broker 无响应: %s" % cmd)
        with self._lock:
            self._pending.pop(request_id, None)
        if not response.get("ok"):
            error = response.get("error") or {}
            raise RuntimeError(error.get("message", "broker 错误"))
        return response.get("data") or {}


# ---------------------------------------------------------------------------
# TUI
# ---------------------------------------------------------------------------
KIND_BADGE = {
    "message": ("●", "cyan"),
    "question": ("❓", "yellow"),
    "progress": ("⏳", "blue"),
    "done": ("✅", "green"),
    "error": ("❌", "red"),
    "note": ("📝", "grey"),
}

HELP_LINES = [
    "HumanChat 终端界面 · 快捷键",
    "",
    "  Enter                        发送消息",
    "  Ctrl+J / Alt+Enter           输入换行",
    "  ↑ ↓ / PgUp PgDn / Home End   滚动消息",
    "  Tab / Shift+Tab              切换会话",
    "  Ctrl+P / Ctrl+N              输入历史",
    "  Ctrl+L                       重绘",
    "  ? 或 F1                      本帮助",
    "  Ctrl+C / Ctrl+D              退出（Agent 仍会在服务端继续等待）",
    "",
    "  以 / 开头的命令：",
    "    /help              帮助",
    "    /sessions          列出会话",
    "    /switch <id>       切换会话",
    "    /new [id]          新建会话",
    "    /rename <标题>     重命名当前会话",
    "    /clear             清空当前会话显示",
    "    /export [路径]     导出会话记录",
    "    /status            通道状态",
    "    /rules             查看强制规则",
    "    /quit              退出",
    "",
    "按任意键返回…",
]


class Tui:
    def __init__(
        self,
        cfg: Config,
        client: BrokerClient,
        session: str,
        no_color: bool = False,
    ) -> None:
        self.cfg = cfg
        self.client = client
        self.session = session
        self.style = Style(enabled=not no_color)
        self.scroll = 0
        self.buffer = ""
        self.cursor = 0
        self.history: List[str] = []
        self.history_index = -1
        self.status = "连接中…"
        self.agent_status: Dict[str, Any] = {}
        self.sessions: List[dict] = []
        self.messages: List[dict] = []
        self.help_visible = False
        self.toast = ""
        self.toast_until = 0.0
        self.dirty = True
        self._running = True
        self._fd = sys.stdin.fileno() if sys.stdin.isatty() else None
        self._windows_console = os.name == "nt" and self._fd is not None
        self._old_term = None
        self._old_console_mode = None
        self._spinner = 0
        self._paste = False

    # ------------------------------------------------------------ 生命周期
    def enter(self) -> None:
        # 1049 = 备用屏幕；25l = 隐藏光标；2004h = 开启 bracketed paste（多行粘贴不会被逐行发送）
        sys.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[H")
        sys.stdout.flush()
        if self._windows_console:
            self._enter_windows_console()
        elif self._fd is not None:
            import termios
            import tty

            self._old_term = termios.tcgetattr(self._fd)
            tty.setraw(self._fd)

    def leave(self) -> None:
        if self._windows_console:
            self._leave_windows_console()
        elif self._old_term is not None and self._fd is not None:
            import termios

            try:
                termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old_term)
            except Exception:
                pass
        sys.stdout.write("\x1b[?2004l\x1b[?25h\x1b[?1049l")
        sys.stdout.flush()

    def size(self) -> Tuple[int, int]:
        size = shutil.get_terminal_size((100, 30))
        return max(size.lines, 10), max(size.columns, 40)

    # ------------------------------------------------------------ 数据
    def load(self) -> None:
        try:
            data = self.client.request("history", session=self.session, limit=400)
        except Exception as exc:
            self.toast = "加载失败: %s" % exc
            return
        snapshot = data.get("session") or {}
        self.messages = snapshot.get("messages") or []
        self.agent_status = snapshot.get("status") or {}
        self.scroll = 0

    def refresh_sessions(self) -> None:
        try:
            data = self.client.request("sessions", timeout=5.0)
            self.sessions = data.get("sessions") or []
        except Exception:
            pass

    def send(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if text.startswith("/"):
            self.handle_command(text)
            return
        try:
            self.client.request("send", session=self.session, text=text)
        except Exception as exc:
            self.toast_now("发送失败: %s" % exc)
            return
        self.history.append(text)
        self.history_index = -1
        self.buffer = ""
        self.cursor = 0
        self.scroll = 0
        self.dirty = True

    def toast_now(self, text: str, seconds: float = 4.0) -> None:
        self.toast = text
        self.toast_until = time.time() + seconds
        self.dirty = True

    def handle_command(self, text: str) -> None:
        parts = text[1:].split(" ", 1)
        cmd = parts[0].strip().lower()
        arg = parts[1].strip() if len(parts) > 1 else ""
        if cmd in ("help", "h", "?"):
            self.help_visible = True
        elif cmd in ("quit", "exit", "q"):
            self._running = False
        elif cmd == "sessions":
            self.refresh_sessions()
            names = ", ".join(item["id"] for item in self.sessions) or "(无)"
            self.toast_now("会话: %s" % names)
        elif cmd == "switch":
            if not arg:
                self.toast_now("用法: /switch <会话 id>")
            else:
                self.switch_session(arg)
        elif cmd == "new":
            try:
                data = self.client.request("new", session=arg or "", title=arg)
                self.session = (data.get("session") or {}).get("id", arg)
                self.messages = []
                self.refresh_sessions()
                self.toast_now("已新建会话 %s" % self.session)
            except Exception as exc:
                self.toast_now("新建失败: %s" % exc)
        elif cmd == "rename":
            try:
                self.client.request("rename", session=self.session, title=arg)
                self.toast_now("已重命名")
            except Exception as exc:
                self.toast_now("重命名失败: %s" % exc)
        elif cmd == "clear":
            try:
                self.client.request("clear", session=self.session)
                self.messages = []
                self.toast_now("已清空")
            except Exception as exc:
                self.toast_now("清空失败: %s" % exc)
        elif cmd == "export":
            path = os.path.expanduser(arg) if arg else str(self.cfg.home / ("transcript-%s.md" % self.session))
            try:
                self.client.request("export", session=self.session, path=path)
                self.toast_now("已导出到 %s" % path)
            except Exception as exc:
                self.toast_now("导出失败: %s" % exc)
        elif cmd == "status":
            try:
                data = self.client.request("status", session=self.session)
                attached = "是" if data.get("human_attached") else "否"
                self.toast_now(
                    "人类终端: %s · Agent: %s · 未读: %s"
                    % (attached, (data.get("status") or {}).get("state", "?"), data.get("pending_count", 0))
                )
            except Exception as exc:
                self.toast_now("查询失败: %s" % exc)
        elif cmd == "rules":
            self.toast_now("规则即：Agent 不许用内置提问工具、不许自行结束对话、必须循环调用 human_wait。")
        else:
            self.toast_now("未知命令: /%s（/help 查看帮助）" % cmd)
        self.buffer = ""
        self.cursor = 0
        self.dirty = True

    def switch_session(self, session_id: str) -> None:
        self.session = session_id
        try:
            self.client.request("hello", role="human", client=self.client.client_name, session=session_id)
        except Exception:
            pass
        self.load()
        self.toast_now("已切换到会话 %s" % session_id)

    # ------------------------------------------------------------ 渲染
    def _header(self, cols: int) -> str:
        state = self.agent_status.get("state", "idle")
        if state == "waiting":
            since = self.agent_status.get("since", time.time())
            elapsed = int(time.time() - since)
            state_text = "🔔 正在等待你的回复 (%02d:%02d)" % (elapsed // 60, elapsed % 60)
            state_text = self.style.reverse(self.style.bold(" " + state_text + " "))
        elif state == "working":
            state_text = self.style.green("Agent: 处理中")
        else:
            state_text = self.style.grey("Agent: 空闲")
        left = self.style.bold(" humanchat ") + self.style.grey("│ %s │ %d 条消息" % (self.session, len(self.messages)))
        right = state_text
        pad = cols - display_width(_strip_ansi(left)) - display_width(_strip_ansi(right)) - 2
        if pad < 1:
            return truncate(_strip_ansi(left), cols)
        return left + " " * pad + right + " "

    def _message_lines(self, width: int) -> List[str]:
        lines: List[str] = []
        for message in self.messages:
            role = message.get("role", "?")
            kind = message.get("kind", "message")
            when = time.strftime("%H:%M:%S", time.localtime(message.get("ts", 0)))
            badge, color = KIND_BADGE.get(kind, ("●", "cyan"))
            if role == "human":
                who = self.style.green("你")
                badge = "🧑"
            elif role == "agent":
                who = self.style.cyan("Agent")
            else:
                who = self.style.grey("系统")
            head = "  %s %s %s" % (badge, who, self.style.grey(when + (" · " + kind if kind != "message" else "")))
            lines.append(head)
            text_color = {
                "done": self.style.green,
                "error": self.style.red,
                "question": self.style.yellow,
                "progress": self.style.grey,
                "note": self.style.grey,
            }.get(kind, (self.style.blue if role == "human" else lambda t: t))
            for line in wrap_text(message.get("text", ""), max(10, width - 6)):
                lines.append("    " + text_color(line))
            lines.append("")
        if not lines:
            lines = [
                "",
                self.style.grey("  还没有消息。"),
                self.style.grey("  Agent 完成任务后会在这里汇报，然后等待你的下一句话。"),
                "",
            ]
        return lines

    def _input_lines(self, cols: int) -> List[str]:
        width = cols - 4
        text = self.buffer if self.buffer else ""
        if not text:
            return ["  " + self.style.grey("说点什么…（Enter 发送 · Ctrl+J 换行 · F1 帮助）")]
        lines = wrap_text(text, max(10, width)) or [""]
        return ["  " + line for line in lines[-6:]]

    def _footer(self, cols: int) -> str:
        waiting = self.agent_status.get("state") == "waiting"
        if waiting:
            reason = self.agent_status.get("reason") or ""
            hint = self.agent_status.get("hint") or ""
            text = " 输入后按 Enter 发送给正在等待的 Agent"
            if reason:
                text += " · 它在等: " + truncate(reason, 40)
            if hint:
                text += " · " + truncate(hint, 30)
            return self.style.reverse(truncate(text, cols).ljust(cols))
        return self.style.grey(
            truncate(" Enter 发送 · Ctrl+J 换行 · ↑↓ 滚动 · Tab 会话 · / 命令 · F1 帮助 · Ctrl+C 退出", cols)
        )

    def render(self) -> None:
        rows, cols = self.size()
        out: List[str] = ["\x1b[H"]
        if self.help_visible:
            body = "\n".join(HELP_LINES)
            for line in body.split("\n")[: rows - 1]:
                out.append("\x1b[2K" + truncate(line, cols) + "\r\n")
            out.append("\x1b[J")
            sys.stdout.write("".join(out))
            sys.stdout.flush()
            return

        header = self._header(cols)
        message_lines = self._message_lines(cols)
        input_lines = self._input_lines(cols)
        footer = self._footer(cols)

        input_height = len(input_lines)
        fixed = 1 + 1 + input_height + 1 + 1  # header + separator + input + footer + toast
        view_height = max(3, rows - fixed)

        total = len(message_lines)
        max_scroll = max(0, total - view_height)
        self.scroll = min(self.scroll, max_scroll)
        end = total - self.scroll
        start = max(0, end - view_height)
        window = message_lines[start:end]
        while len(window) < view_height:
            window.append("")

        out.append("\x1b[2K" + header + "\r\n")
        out.append("\x1b[2K" + self.style.grey("─" * cols) + "\r\n")
        for line in window:
            pad = cols - display_width(_strip_ansi(line))
            out.append("\x1b[2K" + line + (" " * max(0, pad)) + "\r\n")
        out.append("\x1b[2K" + self.style.grey("─" * cols) + "\r\n")
        for line in input_lines:
            pad = cols - display_width(_strip_ansi(line))
            out.append("\x1b[2K" + line + " " * max(0, pad) + "\r\n")
        toast_line = ""
        if self.toast and time.time() < self.toast_until:
            toast_line = self.style.yellow(" " + self.toast)
        elif self.scroll > 0:
            toast_line = self.style.grey(" ↑ 已向上滚动 %d 行（End 回到最新）" % self.scroll)
        out.append("\x1b[2K" + truncate(toast_line, cols).ljust(cols) + "\r\n")
        out.append("\x1b[2K" + footer)

        # 光标定位到输入框末尾
        input_row = rows - 2
        last_len = display_width(_strip_ansi(input_lines[-1])) if input_lines else 0
        out.append("\x1b[%d;%dH" % (input_row, min(cols, last_len + 2)))
        out.append("\x1b[?25h")

        sys.stdout.write("".join(out))
        sys.stdout.flush()
        self.dirty = False

    # ------------------------------------------------------------ 重连
    def _reconnect(self) -> bool:
        """broker 可能随 AgentDock 一起重启 —— 自动重连，界面不退出。"""
        deadline = time.time() + 30
        attempt = 0
        while time.time() < deadline and self._running:
            attempt += 1
            self.toast_now("与 broker 断开，正在重连…（第 %d 次）" % attempt, seconds=1.5)
            self.render()
            endpoint = find_endpoint(self.cfg) or self.client.endpoint
            try:
                new_client = BrokerClient(self.cfg, endpoint, role="human", client_name=self.client.client_name)
                new_client.connect(session=self.session)
            except Exception as exc:
                self.client.last_error = str(exc)
                time.sleep(0.8)
                continue
            old = self.client
            self.client = new_client
            try:
                old.close()
            except Exception:
                pass
            self.messages = []
            self.load()
            self.refresh_sessions()
            self.toast_now("已重新连接 broker", seconds=3.0)
            self.dirty = True
            return True
        return False

    # ------------------------------------------------------------ 主循环
    def run(self) -> int:
        self.enter()
        try:
            self.load()
            self.refresh_sessions()
            while self._running:
                self._drain_events()
                if self.dirty:
                    self.render()
                if self.help_visible:
                    self._wait_key(timeout=0.5)
                    if self.help_visible and self._last_key_was_any():
                        self.help_visible = False
                        self.dirty = True
                    continue
                chunk = self._read_key(timeout=0.08)
                if chunk:
                    self._handle_key(chunk)
                if not self.client.connected:
                    if not self._reconnect():
                        self.leave()
                        sys.stdout.write("与 broker 的连接已断开且无法重连。\n")
                        return 3
        finally:
            self.leave()
        return 0

    def _last_key_was_any(self) -> bool:
        return True

    def _drain_events(self) -> None:
        while True:
            try:
                event = self.client.events.get_nowait()
            except queue.Empty:
                break
            name = event.get("event")
            if name == "message":
                message = event.get("message") or {}
                if event.get("session") and event["session"] != self.session:
                    continue
                self.messages.append(message)
                if message.get("role") == "agent":
                    self.agent_status = {"state": "working", "since": time.time()}
                    if message.get("kind") in (KIND_DONE, KIND_QUESTION, KIND_ERROR):
                        sys.stdout.write("\a")
                        sys.stdout.flush()
                    self._notify_desktop(message)
                self.scroll = 0
                self.dirty = True
            elif name == "status":
                if event.get("session") and event["session"] != self.session:
                    continue
                self.agent_status = event.get("status") or {}
                if self.agent_status.get("state") == "waiting":
                    sys.stdout.write("\a")
                    sys.stdout.flush()
                self.dirty = True
            elif name == "cleared":
                if event.get("session") == self.session:
                    self.messages = []
                    self.dirty = True
            elif name == "sessions":
                self.sessions = event.get("sessions") or []
            elif name == "clients":
                self.dirty = True
            elif name == "disconnected":
                self.toast_now("broker 已断开")
                self.dirty = True
        if self.agent_status.get("state") == "waiting":
            self.dirty = True  # 让等待计时器走动
        elif self.toast and time.time() >= self.toast_until:
            self.toast = ""
            self.dirty = True

    def _notify_desktop(self, message: dict) -> None:
        title = "HumanChat · Agent"
        text = (message.get("text") or "")[:200]
        try:
            if sys.platform == "darwin" and shutil.which("osascript"):
                subprocess.Popen(
                    ["osascript", "-e", 'display notification "%s" with title "%s"' % (text.replace('"', "'"), title)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            elif shutil.which("notify-send"):
                subprocess.Popen(["notify-send", title, text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

    # ------------------------------------------------------------ Windows 控制台
    def _enter_windows_console(self) -> None:
        """Windows 没有 termios：用 Win32 控制台模式 + msvcrt 代替 raw mode。

        同时打开 ENABLE_VIRTUAL_TERMINAL_PROCESSING —— 否则 TUI 画界面用的
        ANSI 转义序列（备用屏幕 / 光标 / 颜色）会被原样打印成乱码。
        """
        try:
            import ctypes
            import msvcrt  # noqa: F401  （确认当前解释器有控制台支持）

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                self._old_console_mode = mode.value
                # 0x0004 = ENABLE_VIRTUAL_TERMINAL_PROCESSING
                kernel32.SetConsoleMode(handle, mode.value | 0x0004)
        except Exception:
            # 拿不到控制台就当普通终端用；界面可能不好看，但不该因此退出
            self._old_console_mode = None

    def _leave_windows_console(self) -> None:
        if self._old_console_mode is None:
            return
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), self._old_console_mode)
        except Exception:
            pass
        self._old_console_mode = None

    def _read_key_windows(self, timeout: float = 0.1) -> Optional[str]:
        """Windows 版按键读取：msvcrt.kbhit() 轮询，行为对齐 POSIX 分支。"""
        import msvcrt

        if self._fd is None:
            return None
        deadline = time.time() + max(0.0, timeout)
        while True:
            if msvcrt.kbhit():
                try:
                    char = msvcrt.getwch()
                except (OSError, ValueError):
                    return None
                if char == "\x00" or char == "\xe0":
                    # 功能键 / 方向键：第二个字节才是扫描码
                    try:
                        char = "\x1b[" + msvcrt.getwch()
                    except (OSError, ValueError):
                        return None
                elif char == "\r":
                    char = "\n"  # Windows 控制台回车是 \r\n，统一成 \n
                return char
            if time.time() >= deadline:
                return None
            time.sleep(0.01)

    # ------------------------------------------------------------ 按键
    def _read_key(self, timeout: float = 0.1) -> Optional[str]:
        import select

        if self._fd is None:
            return None
        if self._windows_console:
            return self._read_key_windows(timeout)
        try:
            ready, _, _ = select.select([self._fd], [], [], timeout)
        except (OSError, ValueError):
            return None
        if not ready:
            return None
        try:
            data = os.read(self._fd, 1024)
        except OSError:
            return None
        if not data:
            self._running = False
            return None
        text = data.decode("utf-8", errors="replace")
        if text.startswith("\x1b") and len(text) == 1:
            # 可能是转义序列的开头，稍等一会儿收集剩余字节
            try:
                ready2, _, _ = select.select([self._fd], [], [], 0.03)
                if ready2:
                    text += os.read(self._fd, 1024).decode("utf-8", errors="replace")
            except OSError:
                pass
        return text

    def _wait_key(self, timeout: float = 0.3) -> None:
        self._read_key(timeout=timeout)

    def _insert(self, text: str) -> None:
        printable = "".join(ch for ch in text if ch >= " " or ch in "\n\t")
        if not printable:
            return
        self.buffer = self.buffer[: self.cursor] + printable + self.buffer[self.cursor :]
        self.cursor += len(printable)

    def _handle_key(self, text: str) -> None:
        # 一次 read 可能拿到多个字符（快速输入 / 粘贴 / 终端批量投递）：
        # 必须按“文本 + 回车”拆开处理，否则回车会被吞掉 —— 人类会觉得界面发不出去。
        if self._paste:
            if "\x1b[201~" in text:
                head, _, tail = text.partition("\x1b[201~")
                self._insert(head)
                self._paste = False
                if tail:
                    self._handle_key(tail)
            else:
                self._insert(text)
            self.dirty = True
            return
        if "\x1b[200~" in text:
            head, _, tail = text.partition("\x1b[200~")
            if head:
                self._handle_key(head)
            self._paste = True
            self._insert(tail)
            self.dirty = True
            return
        if "\r" in text and text != "\r":
            head, _, tail = text.partition("\r")
            self._insert(head)
            self.send(self.buffer)
            if tail:
                self._insert(tail)
            self.dirty = True
            return

        if text == "\x03" or text == "\x04":  # Ctrl+C / Ctrl+D
            self._running = False
            return
        if text == "\x0c":  # Ctrl+L
            sys.stdout.write("\x1b[2J")
            self.dirty = True
            return
        if text in ("?", "\x1bOP") and not self.buffer:
            self.help_visible = True
            self.dirty = True
            return
        if text == "\t":
            self._cycle_session(1)
            return
        if text == "\x1b[Z":
            self._cycle_session(-1)
            return
        if text == "\r" or text == "\n":
            self.send(self.buffer)
            return
        if text == "\n" or text == "\x0a":  # 注意：raw 模式下 Enter 是 \r
            return
        if text == "\x10":  # Ctrl+P 输入历史上一条
            self._history_move(-1)
            return
        if text == "\x0e":  # Ctrl+N
            self._history_move(1)
            return
        if text in ("\x7f", "\x08"):
            if self.cursor > 0:
                self.buffer = self.buffer[: self.cursor - 1] + self.buffer[self.cursor :]
                self.cursor -= 1
            self.dirty = True
            return
        if text == "\x1b[3~":
            self.buffer = self.buffer[: self.cursor] + self.buffer[self.cursor + 1 :]
            self.dirty = True
            return
        if text in ("\x1b[A", "\x1bOA"):
            self.scroll += 1
            self.dirty = True
            return
        if text in ("\x1b[B", "\x1bOB"):
            self.scroll = max(0, self.scroll - 1)
            self.dirty = True
            return
        if text in ("\x1b[5~",):
            rows, _ = self.size()
            self.scroll += max(3, rows - 8)
            self.dirty = True
            return
        if text in ("\x1b[6~",):
            rows, _ = self.size()
            self.scroll = max(0, self.scroll - max(3, rows - 8))
            self.dirty = True
            return
        if text in ("\x1b[H", "\x1bOH", "\x01"):  # Home / Ctrl+A
            self.cursor = 0
            self.dirty = True
            return
        if text in ("\x1b[F", "\x1bOF", "\x05"):  # End / Ctrl+E
            self.cursor = len(self.buffer)
            self.dirty = True
            return
        if text == "\x1b[4~":
            self.cursor = len(self.buffer)
            self.dirty = True
            return
        if text in ("\x1b[C", "\x1bOC"):
            self.cursor = min(len(self.buffer), self.cursor + 1)
            self.dirty = True
            return
        if text in ("\x1b[D", "\x1bOD"):
            self.cursor = max(0, self.cursor - 1)
            self.dirty = True
            return
        if text in ("\x0a", "\x1b\r", "\x1b\x0a"):
            self.buffer = self.buffer[: self.cursor] + "\n" + self.buffer[self.cursor :]
            self.cursor += 1
            self.dirty = True
            return
        if text.startswith("\x1b"):
            return  # 其它未知转义序列忽略
        # 普通输入
        printable = "".join(ch for ch in text if ch >= " " or ch in "\t")
        if not printable:
            return
        self.buffer = self.buffer[: self.cursor] + printable + self.buffer[self.cursor :]
        self.cursor += len(printable)
        self.dirty = True

    def _history_move(self, direction: int) -> None:
        if not self.history:
            return
        if self.history_index == -1:
            self.history_index = len(self.history) - 1 if direction < 0 else -1
        else:
            self.history_index = max(0, min(len(self.history) - 1, self.history_index + direction))
        if 0 <= self.history_index < len(self.history):
            self.buffer = self.history[self.history_index]
            self.cursor = len(self.buffer)
        self.dirty = True

    def _cycle_session(self, step: int) -> None:
        self.refresh_sessions()
        ids = [item["id"] for item in self.sessions] or [self.session]
        if self.session in ids:
            index = (ids.index(self.session) + step) % len(ids)
        else:
            index = 0
        self.switch_session(ids[index])


def _strip_ansi(text: str) -> str:
    out = []
    i = 0
    while i < len(text):
        if text[i] == "\x1b":
            j = i + 1
            while j < len(text) and text[j] not in "mK":
                j += 1
            i = j + 1
            continue
        out.append(text[i])
        i += 1
    return "".join(out)


# ---------------------------------------------------------------------------
# 简单逐行模式
# ---------------------------------------------------------------------------
class _SimpleState:
    """逐行模式的共享状态（支持 broker 重启后自动重连）。"""

    def __init__(self, cfg: Config, client: BrokerClient, session: str) -> None:
        self.cfg = cfg
        self.client = client
        self.session = session
        self.stop = threading.Event()
        self.lock = threading.Lock()


def simple_loop(cfg: Config, client: BrokerClient, session: str) -> int:
    style = Style(enabled=sys.stdout.isatty())
    state = _SimpleState(cfg, client, session)
    print(style.bold("HumanChat") + style.grey(" · 逐行模式 · 会话 %s" % session))
    print(style.grey("直接输入并回车即可发送；Ctrl+C 退出。"))

    def pump() -> None:
        while not state.stop.is_set():
            current = state.client
            try:
                event = current.events.get(timeout=0.5)
            except queue.Empty:
                continue
            except Exception:
                return
            name = event.get("event")
            if name == "message":
                message = event.get("message") or {}
                if event.get("session") != state.session or message.get("role") != "agent":
                    continue
                when = time.strftime("%H:%M:%S", time.localtime(message.get("ts", 0)))
                kind = message.get("kind", "message")
                print("\n%s" % style.cyan("[Agent %s · %s]" % (when, kind)))
                print(message.get("text", ""))
                sys.stdout.write("> ")
                sys.stdout.flush()
            elif name == "status":
                if event.get("session") != state.session:
                    continue
                if (event.get("status") or {}).get("state") == "waiting":
                    print(style.reverse(" Agent 正在等待你的回复 "))
                    sys.stdout.write("> ")
                    sys.stdout.flush()
            elif name == "disconnected":
                print(style.yellow("\n与 broker 的连接已断开，正在尝试重连…"))
                for _ in range(30):
                    if state.stop.is_set():
                        return
                    time.sleep(1.0)
                    try:
                        fresh = BrokerClient(
                            cfg, find_endpoint(cfg) or current.endpoint, role="human", client_name="humanchat-simple"
                        )
                        fresh.connect(session=state.session)
                    except Exception:
                        continue
                    with state.lock:
                        state.client = fresh
                    print(style.green("已重新连接 broker。"))
                    sys.stdout.write("> ")
                    sys.stdout.flush()
                    break
                else:
                    print(style.red("重连失败，请重新运行 humanchat attach。"))
                    state.stop.set()
                    return

    threading.Thread(target=pump, daemon=True).start()
    data = client.request("history", session=session, limit=50)
    for message in (data.get("session") or {}).get("messages", []):
        who = {"agent": "Agent", "human": "你 ", "system": "系统"}.get(message.get("role"), "?")
        print(
            style.grey(
                "[%s] %s: %s"
                % (time.strftime("%H:%M:%S", time.localtime(message.get("ts", 0))), who, message.get("text", ""))
            )
        )
    try:
        while True:
            try:
                line = input("> ")
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            if not line.strip():
                continue
            if line.startswith("/"):
                command = line[1:].strip().lower()
                if command in ("quit", "exit", "q"):
                    return 0
                if command == "help":
                    print("\n".join(HELP_LINES))
                    continue
                print("（逐行模式仅支持 /help /quit）")
                continue
            with state.lock:
                current = state.client
            try:
                current.request("send", session=session, text=line)
            except Exception as exc:
                print(style.red("发送失败: %s" % exc))
    finally:
        state.stop.set()


def _print(text: str = "") -> None:
    print(text)


def _ensure_broker(cfg: Config, log: Log, spawn: bool = True) -> Optional[str]:
    endpoint = find_endpoint(cfg)
    if endpoint:
        return endpoint
    if not spawn:
        return None
    # 没有 broker 就自己拉起一个常驻 broker，人类可以先说话
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = [sys.executable, os.path.join(root, "humanchat_mcp.py"), "--broker", "--daemon"]
    kwargs: Dict[str, Any] = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(args, **kwargs)
    except Exception as exc:
        log.warn("启动 broker 守护进程失败: %r" % (exc,))
        return None
    for _ in range(40):
        time.sleep(0.15)
        endpoint = find_endpoint(cfg)
        if endpoint:
            return endpoint
    return None


def cmd_attach(cfg: Config, log: Log, args: List[str]) -> int:
    session = cfg.default_session
    simple = False
    no_color = False
    spawn = True
    index = 0
    while index < len(args):
        item = args[index]
        if item in ("--session", "-s") and index + 1 < len(args):
            session = args[index + 1]
            index += 2
            continue
        if item == "--simple" or item == "--plain":
            simple = True
        elif item == "--no-color":
            no_color = True
        elif item == "--no-spawn":
            spawn = False
        index += 1

    endpoint = _ensure_broker(cfg, log, spawn=spawn)
    if not endpoint:
        _print("找不到 broker，也未能自动启动。请先运行： humanchat-mcp --broker --daemon")
        return 2
    client = BrokerClient(cfg, endpoint, role="human", client_name="humanchat-tui")
    try:
        client.connect(session=session)
    except Exception as exc:
        _print("连接 broker 失败: %s" % exc)
        return 2
    try:
        if simple or not sys.stdin.isatty() or not sys.stdout.isatty():
            return simple_loop(cfg, client, session)
        tui = Tui(cfg, client, session, no_color=no_color)
        # SIGWINCH 只在 POSIX 存在；Windows 上直接注册会抛 AttributeError（TUI 永远起不来）
        if hasattr(signal, "SIGWINCH"):
            signal.signal(signal.SIGWINCH, lambda *_: None)
        return tui.run()
    finally:
        client.close()


def cmd_send(cfg: Config, log: Log, args: List[str]) -> int:
    if not args:
        _print('用法: humanchat send "要说的话" [--session default]')
        return 2
    session = cfg.default_session
    text_parts = []
    index = 0
    while index < len(args):
        if args[index] in ("--session", "-s") and index + 1 < len(args):
            session = args[index + 1]
            index += 2
            continue
        text_parts.append(args[index])
        index += 1
    text = " ".join(text_parts)
    endpoint = _ensure_broker(cfg, log, spawn=True)
    if not endpoint:
        _print("找不到 broker。")
        return 2
    client = BrokerClient(cfg, endpoint, role="human", client_name="humanchat-send")
    try:
        client.connect(session=session)
        client.request("send", session=session, text=text)
        _print("已发送到会话 %s" % session)
        return 0
    except Exception as exc:
        _print("发送失败: %s" % exc)
        return 2
    finally:
        client.close()


def cmd_status(cfg: Config, log: Log, args: List[str]) -> int:
    endpoint = find_endpoint(cfg)
    if not endpoint:
        _print("没有正在运行的 broker（Agent 尚未启动，或已被关闭）。")
        _print("可执行： humanchat-mcp --broker --daemon  （或 humanchat attach --session %s）" % cfg.default_session)
        return 1
    client = BrokerClient(cfg, endpoint, role="human", client_name="humanchat-status")
    try:
        client.connect()
        data = client.request("status", session=cfg.default_session)
        server = data.get("server") or {}
        _print("broker: pid=%s endpoint=%s" % (server.get("pid"), server.get("endpoint")))
        _print("人类终端连接: %s" % ("是" if data.get("human_attached") else "否"))
        _print("Agent 状态: %s" % (data.get("status") or {}).get("state"))
        _print("未处理的人类消息: %s" % data.get("pending_count"))
        sessions = client.request("sessions").get("sessions") or []
        _print("会话:")
        for item in sessions:
            _print("  · %-16s %s 条  %s" % (item.get("id"), item.get("count"), (item.get("preview") or "")[:50]))
        return 0
    except Exception as exc:
        _print("查询失败: %s" % exc)
        return 2
    finally:
        client.close()


def cmd_quit_broker(cfg: Config, log: Log, args: List[str]) -> int:
    endpoint = find_endpoint(cfg)
    if not endpoint:
        _print("没有正在运行的 broker。")
        return 0
    client = BrokerClient(cfg, endpoint, role="human", client_name="humanchat-quit")
    try:
        client.connect()
        client.request("shutdown", timeout=3.0)
        _print("已请求 broker 停止。")
        return 0
    except Exception as exc:
        _print("停止失败: %s" % exc)
        return 2
    finally:
        client.close()


def cmd_web(cfg: Config, log: Log, args: List[str]) -> int:
    """浏览器界面（人类侧）。实现见 humanchat/webui.py。"""
    from .webui import run_web

    return run_web(cfg, log, args)


COMMANDS = {
    "attach": cmd_attach,
    "tui": cmd_attach,
    "web": cmd_web,
    "ui": cmd_web,
    "send": cmd_send,
    "status": cmd_status,
    "sessions": cmd_status,
    "quit-broker": cmd_quit_broker,
}


def main(argv: List[str]) -> int:
    cfg = Config()
    cfg.ensure_dirs()
    log = Log(cfg.broker_log, cfg.log_level, "cli")
    command = "attach"
    args = list(argv)
    if args and args[0] in COMMANDS:
        command = args[0]
        args = args[1:]
    elif args and args[0] in ("-h", "--help", "help"):
        _print(__doc__)
        return 0
    elif args and args[0] in ("-V", "--version", "version"):
        _print("humanchat %s" % VERSION)
        return 0
    handler = COMMANDS.get(command)
    if handler is None:
        _print("未知命令: %s" % command)
        return 2
    return handler(cfg, log, args)


def console_main() -> int:
    """console_scripts 入口：humanchat …"""
    return main(sys.argv[1:])
