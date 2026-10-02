"""在真实 PTY 里跑人类终端界面，验证渲染与输入（仅 POSIX）。

流程：起 broker → 在 PTY 里启动 TUI → 模拟按键输入 → 用 MCP stdio 客户端
的 human_wait 取回这条消息。等于把“人类在终端说话 → Agent 收到”整条链路走一遍。
"""

from __future__ import annotations

import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

# pty / termios 是 POSIX 专有模块。Windows 上直接 import 会让 unittest 在“发现测试”
# 阶段就抛 ImportError（整个 discover 变成 1 个 error），所以这里必须软失败。
try:
    import pty  # type: ignore
except ImportError:  # pragma: no cover - Windows
    pty = None  # type: ignore

ROOT = Path(__file__).resolve().parents[1]
ENTRY = str(ROOT / "humanchat_mcp.py")
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

POSIX_ONLY = os.name == "posix" and pty is not None and hasattr(os, "openpty")


class PtyBase(unittest.TestCase):
    """提供 PTY 相关的公共工具。"""
    def setUp(self) -> None:
        self._env_backup = {k: v for k, v in os.environ.items() if k.startswith("HUMANCHAT_")}
        for key in list(self._env_backup):
            os.environ.pop(key, None)
        self.home = Path(tempfile.mkdtemp(prefix="humanchat-pty-"))
        os.environ["HUMANCHAT_HOME"] = str(self.home)
        os.environ["HUMANCHAT_AUTOLAUNCH"] = "never"
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        for key in [k for k in os.environ if k.startswith("HUMANCHAT_")]:
            os.environ.pop(key, None)
        os.environ.update(self._env_backup)
        shutil.rmtree(self.home, ignore_errors=True)

    def _spawn_pty(self, args, env_extra=None):
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["LINES"] = "30"
        env["COLUMNS"] = "100"
        env.update(env_extra or {})
        master, slave = pty.openpty()
        proc = subprocess.Popen(
            [sys.executable, ENTRY] + args,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
            cwd=str(ROOT),
            close_fds=True,
        )
        os.close(slave)
        return proc, master

    def _drain(self, master, seconds=1.0):
        chunks = []
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if not ready:
                continue
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            chunks.append(data)
        return b"".join(chunks).decode("utf-8", errors="replace")


@unittest.skipUnless(POSIX_ONLY, "仅支持 POSIX PTY")
class TuiPtyTests(PtyBase):
    def test_tui_send_and_agent_receives(self):
        from test_e2e import StdioMcpClient, wait_for  # type: ignore

        # 1) MCP 服务器（stdio）先启动，它同时托管 broker
        mcp = StdioMcpClient(self.home)
        self.addCleanup(mcp.close)
        init = mcp.call(
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pty-test"}},
        )
        self.assertIn("instructions", init["result"])
        self.assertTrue(wait_for(lambda: (self.home / "broker.json").exists(), timeout=10))

        # 2) 人类在 PTY 里打开 TUI
        tui, master = self._spawn_pty(["attach"])
        self.addCleanup(lambda: (tui.terminate(), os.close(master)))
        banner = self._drain(master, 2.5)
        self.assertIn("humanchat", banner.lower())
        self.assertIn("说点什么", banner)  # 输入框占位提示

        # 3) Agent 调用 human_wait（后台线程），人类随后打字
        thread, box = mcp.call_async(
            "tools/call",
            {"name": "human_wait", "arguments": {"keepalive_seconds": 20, "reason": "等人类提问"}},
        )
        time.sleep(0.6)
        screen = self._drain(master, 0.8)
        self.assertIn("正在等待", screen)  # 等待状态条

        alphabet = "请帮我看看日志"
        os.write(master, alphabet.encode("utf-8"))
        time.sleep(0.4)
        os.write(master, b"\r")  # Enter 发送
        echoed = self._drain(master, 1.0)
        self.assertIn("请帮我看看日志", echoed)

        thread.join(timeout=15)
        self.assertIn("response", box, "human_wait 没有收到人类按键发出的消息")
        structured = box["response"]["result"]["structuredContent"]
        self.assertEqual(structured["status"], "human_message")
        self.assertEqual(structured["message"]["text"], "请帮我看看日志")

        # 4) 人类侧也应当看到 Agent 的回复
        mcp.call(
            "tools/call",
            {"name": "human_notify", "arguments": {"text": "收到，正在看日志", "kind": "done"}},
        )
        screen = self._drain(master, 1.2)
        self.assertIn("收到，正在看日志", screen)

        # 5) Ctrl+C 退出，界面恢复
        os.write(master, b"\x03")
        time.sleep(0.5)
        tui.wait(timeout=5)

    def test_simple_mode_line_input(self):
        from test_e2e import HumanClient  # type: ignore

        # 先起 broker
        broker = subprocess.Popen(
            [sys.executable, ENTRY, "--broker"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=dict(os.environ),
            cwd=str(ROOT),
        )
        self.addCleanup(lambda: (broker.terminate(), broker.wait(timeout=5)))
        from test_e2e import BrokerEndpoint  # type: ignore

        endpoint = BrokerEndpoint(self.home).wait()
        self.assertIsNotNone(endpoint)

        simple, master = self._spawn_pty(["attach", "--simple"])
        self.addCleanup(lambda: (simple.terminate(), os.close(master)))
        self._drain(master, 1.5)
        os.write(master, b"hello from simple\r")
        time.sleep(0.8)

        observer = HumanClient(endpoint)
        observer.connect()
        self.addCleanup(observer.close)
        data = observer.request("history", session="default")
        texts = [m["text"] for m in data["session"]["messages"]]
        self.assertIn("hello from simple", texts)
        simple.terminate()


if __name__ == "__main__":
    unittest.main(verbosity=2)


@unittest.skipUnless(POSIX_ONLY, "仅支持 POSIX PTY")
class TuiReconnectTests(PtyBase):
    def test_tui_reconnects_after_broker_restart(self):
        from test_e2e import StdioMcpClient, wait_for, BrokerEndpoint, HumanClient  # type: ignore

        mcp = StdioMcpClient(self.home)
        mcp.call(
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "reconnect-test"}},
        )
        self.assertTrue(wait_for(lambda: (self.home / "broker.json").exists(), timeout=10))

        tui, master = self._spawn_pty(["attach"])
        self.addCleanup(lambda: (tui.terminate(), os.close(master)))
        self._drain(master, 2.0)

        # 模拟 AgentDock 重启：杀掉带 broker 的 MCP 进程
        mcp.close()
        time.sleep(1.0)
        screen = self._drain(master, 2.0)
        self.assertIn("重连", screen)

        # 人类起一个新的常驻 broker，TUI 应该自动接回去
        env = dict(os.environ)
        broker = subprocess.Popen(
            [sys.executable, ENTRY, "--broker"],
            env=env,
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: (broker.terminate(), broker.wait(timeout=5)))
        self.assertIsNotNone(BrokerEndpoint(self.home).wait(timeout=15))

        def reconnected() -> bool:
            return "已重新连接" in self._drain(master, 1.0)

        self.assertTrue(wait_for(reconnected, timeout=30), "TUI 没有自动重连")

        # 重连之后仍然可以正常发消息
        os.write(master, "重连之后的提问\r".encode("utf-8"))
        time.sleep(1.0)
        endpoint = BrokerEndpoint(self.home).wait(timeout=5)
        observer = HumanClient(endpoint)
        observer.connect()
        self.addCleanup(observer.close)
        texts = [m["text"] for m in observer.request("history", session="default")["session"]["messages"]]
        self.assertIn("重连之后的提问", texts)
        tui.terminate()
