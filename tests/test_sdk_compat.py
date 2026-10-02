"""用官方 MCP Python SDK 作为客户端做兼容性验证（stdio + streamable HTTP）。

AgentDock 使用官方 Go SDK 连接外部 MCP，协议行为一致，因此这里用 Python SDK
做交叉验证：能通过官方 SDK 的 initialize / tools/list / tools/call / 通知，
基本就能被 AgentDock 正常调用。

未安装 mcp 包时自动跳过：
    pip install "mcp"        # 或 pip install "mcp<2"
运行：
    python3 -m unittest tests.test_sdk_compat -v
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRY = str(ROOT / "humanchat_mcp.py")
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))


def attr(obj, *names, default=None):
    """兼容 SDK v1 的 camelCase 与 v2 的 snake_case 字段。"""
    for name in names:
        if hasattr(obj, name):
            return getattr(obj, name)
    return default

try:
    import mcp  # noqa: F401
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    MCP_AVAILABLE = True
except Exception:  # pragma: no cover
    MCP_AVAILABLE = False


def _http_client_factory():
    """兼容 mcp v1（streamablehttp_client）与 v2（streamable_http_client）。"""
    import mcp.client.streamable_http as module

    if hasattr(module, "streamablehttp_client"):
        return module.streamablehttp_client
    return module.streamable_http_client


def _unpack_streams(streams):
    """不同版本返回 tuple 或 TransportStreams 对象。"""
    if isinstance(streams, tuple):
        read, write = streams[0], streams[1]
        getter = streams[2] if len(streams) > 2 else (lambda: None)
        return read, write, getter
    read = getattr(streams, "read_stream", None) or getattr(streams, "read", None)
    write = getattr(streams, "write_stream", None) or getattr(streams, "write", None)
    getter = getattr(streams, "get_session_id", None) or (lambda: None)
    return read, write, getter


def _free_port() -> int:
    """要一个当前可用的本地端口（Windows 上 broker 走 TCP 时需要）。"""
    import socket as _socket

    sock = _socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@unittest.skipUnless(MCP_AVAILABLE, "未安装 mcp SDK")
class SdkCompatTests(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="humanchat-sdk-"))
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self._env = {k: v for k, v in os.environ.items() if k.startswith("HUMANCHAT_")}
        for key in list(self._env):
            os.environ.pop(key, None)
        os.environ["HUMANCHAT_HOME"] = str(self.home)
        os.environ["HUMANCHAT_AUTOLAUNCH"] = "never"
        os.environ["HUMANCHAT_KEEPALIVE_SECONDS"] = "3"
        os.environ["HUMANCHAT_HEARTBEAT_SECONDS"] = "1"
        # Windows 没有 AF_UNIX 时 broker 只能走 TCP，而默认端口 8790 是“一台机器一个”，
        # 会和别的用例 / 正在运行的实例抢端口。强制换成每用例独占的端口。
        os.environ["HUMANCHAT_TCP"] = "1"
        os.environ["HUMANCHAT_TCP_PORT"] = str(_free_port())
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        for key in [k for k in os.environ if k.startswith("HUMANCHAT_")]:
            os.environ.pop(key, None)
        os.environ.update(self._env)

    # ------------------------------------------------------------------ 工具
    def _human(self, session: str = "default", text: str = "", delay: float = 0.0):
        from test_e2e import BrokerEndpoint, HumanClient, wait_for  # type: ignore

        endpoint = wait_for(lambda: (BrokerEndpoint(self.home).wait(timeout=1) or None), timeout=15)
        self.assertIsNotNone(endpoint, "broker 未启动")
        client = HumanClient(endpoint, session=session)
        client.connect()
        self.addCleanup(client.close)
        if text:
            if delay:
                def later():
                    time.sleep(delay)
                    client.send(text)

                threading.Thread(target=later, daemon=True).start()
            else:
                client.send(text)
        return client

    # ------------------------------------------------------------------ stdio
    def test_stdio_with_official_sdk(self):
        async def main():
            params = StdioServerParameters(
                command=sys.executable,
                args=[ENTRY, "--stdio"],
                env=dict(os.environ),
                cwd=str(ROOT),
            )
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    init = await session.initialize()
                    info = attr(init, "serverInfo", "server_info")
                    self.assertEqual(info.name, "humanchat")
                    self.assertIn("严禁使用任何客户端内置", attr(init, "instructions", default="") or "")

                    tools = await session.list_tools()
                    names = sorted(tool.name for tool in tools.tools)
                    self.assertEqual(names, ["human_notify", "human_rules", "human_status", "human_wait"])

                    # 人类先说话 → human_wait 立刻拿到
                    human = self._human(text="SDK 测试：你好")
                    await asyncio.sleep(0.3)
                    result = await session.call_tool("human_wait", {"keepalive_seconds": 5})
                    self.assertFalse(attr(result, "isError", "is_error", default=False))
                    text = result.content[0].text
                    self.assertIn("SDK 测试：你好", text)

                    # 通知 + then_wait：人类随后回复
                    human2 = self._human(text="收到，继续", delay=0.6)
                    result = await session.call_tool(
                        "human_notify",
                        {"text": "任务完成", "kind": "done", "then_wait": True, "keepalive_seconds": 8},
                    )
                    body = result.content[0].text
                    self.assertIn("任务完成", body)
                    self.assertIn("收到，继续", body)
                    return True

        self.assertTrue(asyncio.run(asyncio.wait_for(main(), timeout=60)))

    # ------------------------------------------------------------------ HTTP
    def test_streamable_http_with_official_sdk(self):
        from test_e2e import wait_for  # type: ignore

        state: dict = {}
        threading.Thread(target=self._run_http_server, args=(state,), daemon=True).start()
        port = wait_for(lambda: state.get("port"), timeout=15)
        self.assertTrue(port, "HTTP 传输未启动")

        async def main():
            client = _http_client_factory()
            async with client("http://127.0.0.1:%d/mcp" % port) as streams:
                read, write, _getter = _unpack_streams(streams)
                async with ClientSession(read, write) as session:
                    init = await session.initialize()
                    self.assertIn("keepalive", (attr(init, "instructions", default="") or "").lower())
                    tools = await session.list_tools()
                    self.assertEqual(len(tools.tools), 4)
                    self._human(text="来自 HTTP SDK 的消息")
                    await asyncio.sleep(0.3)
                    result = await session.call_tool("human_wait", {"keepalive_seconds": 5})
                    self.assertIn("来自 HTTP SDK 的消息", result.content[0].text)
                    return True

        try:
            self.assertTrue(asyncio.run(asyncio.wait_for(main(), timeout=60)))
        finally:
            if state.get("transport"):
                state["transport"].stop()
            time.sleep(0.4)
            if state.get("service"):
                state["service"].close()

    def _run_http_server(self, state: dict) -> None:
        from humanchat.backend import HandoffService, create_backend
        from humanchat.broker import Log
        from humanchat.config import Config
        from humanchat.mcp_core import McpCore
        from humanchat.transports import HttpTransport

        cfg = Config(home=str(self.home))
        cfg.autolaunch = "never"
        cfg.keepalive_seconds = 3
        cfg.heartbeat_seconds = 1
        cfg.http_port = 0
        cfg.ensure_dirs()
        log = Log(cfg.broker_log, "error", "sdk-http")
        backend = create_backend(cfg, log)
        service = HandoffService(cfg, backend, log)
        core = McpCore(cfg, service, log)
        transport = HttpTransport(core, cfg, log, host="127.0.0.1", port=0)
        httpd = transport.build_server()
        state.update({"port": httpd.server_address[1], "transport": transport, "service": service})
        threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True).start()


if __name__ == "__main__":
    unittest.main(verbosity=2)
