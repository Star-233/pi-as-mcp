"""HumanChat MCP 端到端测试（纯标准库 unittest，不需要任何依赖）。

覆盖：
  * stdio MCP：initialize / tools/list / human_notify / human_wait / keepalive / cancel
  * 人类侧 broker 客户端：登录、收事件、发消息
  * Streamable HTTP MCP：会话头、SSE 心跳、JSON 响应
  * 消息永不丢失：等待超时后再次等待仍能取回人类消息
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.client import HTTPConnection
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRY = str(ROOT / "humanchat_mcp.py")
sys.path.insert(0, str(ROOT / "src"))


def _free_port() -> int:
    import socket as _socket

    sock = _socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def wait_for(predicate, timeout=10.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


class BrokerEndpoint:
    def __init__(self, home: Path) -> None:
        self.home = home

    def wait(self, timeout: float = 15.0):
        def check():
            path = self.home / "broker.json"
            if not path.exists():
                return None
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                return None
            return data.get("endpoint")

        return wait_for(check, timeout=timeout)


class HumanClient:
    """最小的人类侧客户端，用于测试。"""

    def __init__(self, endpoint: str, session: str = "default") -> None:
        self.endpoint = endpoint
        self.session = session
        self.sock = None
        self.file = None
        self.events: "queue.Queue[dict]" = queue.Queue()
        self._lock = threading.Lock()

    def connect(self) -> None:
        if self.endpoint.startswith("tcp://"):
            host, _, port = self.endpoint[len("tcp://") :].rpartition(":")
            self.sock = socket.create_connection((host, int(port)), timeout=5)
        else:
            path = self.endpoint[len("unix://") :]
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(5)
            self.sock.connect(path)
        self.file = self.sock.makefile("rwb", buffering=0)
        reader = threading.Thread(target=self._read, daemon=True)
        reader.start()
        self.request("hello", role="human", client="test-human", session=self.session)

    def _read(self) -> None:
        while True:
            try:
                line = self.file.readline()
            except Exception:
                return
            if not line:
                return
            try:
                message = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            self.events.put(message)

    def request(self, cmd: str, timeout: float = 5.0, **payload):
        request_id = uuid.uuid4().hex[:6]
        body = {"id": request_id, "cmd": cmd}
        body.update(payload)
        with self._lock:
            self.file.write((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                message = self.events.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                break
            if message.get("id") == request_id:
                if not message.get("ok"):
                    raise RuntimeError(message.get("error"))
                return message.get("data") or {}
            self.events.put(message)
            time.sleep(0.01)
        raise TimeoutError("无响应: %s" % cmd)

    def send(self, text: str) -> None:
        self.request("send", session=self.session, text=text)

    def wait_event(self, name: str, timeout: float = 5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                message = self.events.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                return None
            if message.get("event") == name:
                return message
            self.events.put(message)
        return None

    def close(self) -> None:
        try:
            if self.file:
                self.file.close()
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


class StdioMcpClient:
    """直接对话 JSON-RPC 的 stdio 客户端（不依赖 MCP SDK）。"""

    def __init__(self, home: Path, extra_env: dict = None) -> None:
        env = dict(os.environ)
        env["HUMANCHAT_HOME"] = str(home)
        env["HUMANCHAT_AUTOLAUNCH"] = "never"
        env["HUMANCHAT_HEARTBEAT_SECONDS"] = "0.5"
        env["HUMANCHAT_KEEPALIVE_SECONDS"] = "2"
        env.update(extra_env or {})
        self.stderr_path = home / "server-stderr.log"
        self._stderr_handle = open(self.stderr_path, "wb")
        self.proc = subprocess.Popen(
            [sys.executable, ENTRY, "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_handle,
            env=env,
            cwd=str(ROOT),
        )
        self.responses: "queue.Queue[dict]" = queue.Queue()
        self.notifications: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.counter = 0

    def _read(self) -> None:
        for raw in self.proc.stdout:
            raw = raw.strip()
            if not raw:
                continue
            try:
                message = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            if "id" in message and message["id"] is not None:
                self.responses.put(message)
            else:
                self.notifications.put(message)

    def send_raw(self, payload: dict) -> None:
        self.proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def call(self, method: str, params: dict = None, timeout: float = 20.0, notify: bool = False):
        if notify:
            self.send_raw({"jsonrpc": "2.0", "method": method, "params": params or {}})
            return None
        self.counter += 1
        request_id = self.counter
        message = {"jsonrpc": "2.0", "method": method, "id": request_id}
        if params is not None:
            message["params"] = params
        self.send_raw(message)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                response = self.responses.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                break
            if response.get("id") == request_id:
                return response
        raise TimeoutError("方法 %s 无响应" % method)

    def call_async(self, method: str, params: dict = None):
        """在后台线程里发起调用，返回 (线程, 结果容器)。"""
        box: dict = {}

        def run():
            try:
                box["response"] = self.call(method, params, timeout=30)
            except Exception as exc:  # noqa: BLE001
                box["error"] = exc

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, box

    def stderr_text(self) -> str:
        try:
            self._stderr_handle.flush()
            return self.stderr_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        try:
            self._stderr_handle.close()
        except Exception:
            pass


class TempHome(unittest.TestCase):
    """每个用例一个临时 HOME，并清理可能跨用例泄漏的 HUMANCHAT_* 环境变量。

    Windows 没有 AF_UNIX，broker 只能走 TCP；若不给每个用例分配独立端口，
    它们会全部抢 8790（旧代码靠 SO_REUSEADDR 静默叠在一起）。生产环境里那正是
    "两个 broker 抢同一端口 → 消息丢失" 的成因，所以这里显式隔离端口。
    """

    def setUp(self) -> None:
        self._env_backup = {k: v for k, v in os.environ.items() if k.startswith("HUMANCHAT_")}
        for key in list(self._env_backup):
            os.environ.pop(key, None)
        os.environ["HUMANCHAT_TCP_PORT"] = str(_free_port())
        self.addCleanup(self._restore_env)
        self.home = Path(tempfile.mkdtemp(prefix="humanchat-test-"))
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)

    def _restore_env(self) -> None:
        for key in [k for k in os.environ if k.startswith("HUMANCHAT_")]:
            os.environ.pop(key, None)
        os.environ.update(self._env_backup)


# ---------------------------------------------------------------------------
class StdioTests(TempHome):
    def setUp(self) -> None:
        super().setUp()
        self.client = StdioMcpClient(self.home)
        self.addCleanup(self.client.close)
        self.human = None

    def human_client(self, session: str = "default") -> HumanClient:
        endpoint = BrokerEndpoint(self.home).wait()
        self.assertIsNotNone(endpoint, "broker 未在 broker.json 中登记")
        client = HumanClient(endpoint, session=session)
        client.connect()
        self.addCleanup(client.close)
        return client

    def init(self) -> dict:
        response = self.client.call(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "unittest", "version": "1"},
            },
        )
        self.client.call("notifications/initialized", {}, notify=True)
        return response["result"]

    # ----------------------------------------------------------------- 基础
    def test_initialize_carries_mandatory_rules(self):
        result = self.init()
        self.assertEqual(result["serverInfo"]["name"], "humanchat")
        instructions = result["instructions"]
        for needle in ("严禁使用任何客户端内置", "human_wait", "keepalive", "NEVER"):
            self.assertIn(needle, instructions)
        self.assertIn("tools", result["capabilities"])

    def test_tools_list(self):
        self.init()
        result = self.client.call("tools/list")["result"]
        names = {tool["name"] for tool in result["tools"]}
        self.assertEqual(names, {"human_notify", "human_wait", "human_status", "human_rules"})
        for tool in result["tools"]:
            self.assertIn("human_wait", tool["description"])
            self.assertTrue(tool["inputSchema"]["type"] == "object")

    def test_notify_reaches_human_terminal(self):
        self.init()
        human = self.human_client()
        result = self.client.call(
            "tools/call",
            {"name": "human_notify", "arguments": {"text": "部署完成", "kind": "done"}},
        )["result"]
        self.assertFalse(result.get("isError"))
        self.assertIn("强制提醒", result["content"][0]["text"])
        self.assertEqual(result["structuredContent"]["status"], "sent")
        event = human.wait_event("message")
        self.assertIsNotNone(event, "人类客户端没有收到消息事件")
        self.assertEqual(event["message"]["text"], "部署完成")
        self.assertEqual(event["message"]["kind"], "done")

    def test_wait_returns_human_message(self):
        self.init()
        human = self.human_client()
        thread, box = self.client.call_async(
            "tools/call",
            {"name": "human_wait", "arguments": {"keepalive_seconds": 10}},
        )
        time.sleep(0.4)
        human.send("帮我再跑一次测试")
        thread.join(timeout=15)
        structured = box["response"]["result"]["structuredContent"]
        self.assertEqual(structured["status"], "human_message")
        self.assertEqual(structured["message"]["text"], "帮我再跑一次测试")
        self.assertIn("人类原话", box["response"]["result"]["content"][0]["text"])

    def test_wait_keepalive_loop_then_message(self):
        self.init()
        human = self.human_client()
        first = self.client.call(
            "tools/call",
            {"name": "human_wait", "arguments": {"keepalive_seconds": 1}},
        )["result"]
        self.assertEqual(first["structuredContent"]["status"], "keepalive")
        self.assertIn("立刻再次调用", first["content"][0]["text"])
        # 人类此刻说话；再次等待必须立刻拿到消息（消息永不丢失）
        human.send("在吗？")
        second = self.client.call(
            "tools/call",
            {"name": "human_wait", "arguments": {"keepalive_seconds": 5}},
        )["result"]
        self.assertEqual(second["structuredContent"]["status"], "human_message")
        self.assertEqual(second["structuredContent"]["message"]["text"], "在吗？")

    def test_message_survives_missing_wait(self):
        """没有人在等待时人类发的消息也不会丢。"""
        self.init()
        human = self.human_client()
        human.send("我先说了")
        result = self.client.call("tools/call", {"name": "human_status", "arguments": {}})["result"]
        self.assertTrue(result["structuredContent"]["pending_count"] >= 1)
        backlog = self.client.call(
            "tools/call",
            {"name": "human_status", "arguments": {"include_backlog": True}},
        )["result"]
        self.assertEqual(backlog["structuredContent"]["messages"][0]["text"], "我先说了")

    def test_progress_notifications_and_cancel(self):
        self.init()
        thread, box = self.client.call_async(
            "tools/call",
            {
                "name": "human_wait",
                "arguments": {"keepalive_seconds": 30},
                "_meta": {"progressToken": "tok-1"},
            },
        )
        # 心跳：progress 通知会周期性出现（心跳 0.5s）
        seen_progress = None
        deadline = time.time() + 5
        while time.time() < deadline and seen_progress is None:
            try:
                note = self.client.notifications.get(timeout=0.5)
            except queue.Empty:
                continue
            if note.get("method") == "notifications/progress":
                seen_progress = note
            else:
                self.client.notifications.put(note)
                time.sleep(0.02)
        self.assertIsNotNone(seen_progress, "长等待期间没有收到 progress 通知")
        self.assertEqual(seen_progress["params"]["progressToken"], "tok-1")

        self.client.call(
            "notifications/cancelled",
            {"requestId": 2, "reason": "test"},
            notify=True,
        )
        thread.join(timeout=10)
        self.assertIn("response", box)
        self.assertEqual(box["response"]["result"]["structuredContent"]["status"], "cancelled")

    def test_rules_tool(self):
        self.init()
        result = self.client.call("tools/call", {"name": "human_rules", "arguments": {}})["result"]
        text = result["content"][0]["text"]
        self.assertIn("人类原话", text) if result.get("isError") else None
        self.assertIn("严禁使用任何客户端内置", text)
        self.assertIn("ask_user", text)
        self.assertIn("human_wait", text)

    def test_resources_and_prompts(self):
        self.init()
        resources = self.client.call("resources/list")["result"]["resources"]
        self.assertTrue(any(item["uri"] == "humanchat://rules" for item in resources))
        read = self.client.call("resources/read", {"uri": "humanchat://rules"})["result"]
        self.assertIn("human_wait", read["contents"][0]["text"])
        prompts = self.client.call("prompts/list")["result"]["prompts"]
        self.assertEqual(prompts[0]["name"], "human_handoff")
        got = self.client.call("prompts/get", {"name": "human_handoff", "arguments": {"summary": "收尾"}})["result"]
        self.assertIn("human_notify", got["messages"][0]["content"]["text"])

    def test_unknown_tool_returns_error_not_crash(self):
        self.init()
        response = self.client.call("tools/call", {"name": "nope", "arguments": {}})
        self.assertIn("error", response)
        self.assertEqual(response["error"]["code"], -32602)
        # 服务器仍然健康
        self.assertEqual(self.client.call("ping")["result"], {})


# ---------------------------------------------------------------------------
class HttpTests(TempHome):
    def setUp(self) -> None:
        super().setUp()
        from humanchat.backend import HandoffService, create_backend
        from humanchat.broker import Log
        from humanchat.config import Config
        from humanchat.mcp_core import McpCore
        from humanchat.transports import HttpTransport

        self.cfg = Config(home=str(self.home))
        self.cfg.autolaunch = "never"
        self.cfg.heartbeat_seconds = 0.4
        # 用 TCP 而不是 UDS：HTTP 测试会跨连接复用 broker
        self.cfg.use_tcp = True
        self.cfg.tcp_port = _free_port()
        self.cfg.ensure_dirs()
        self.log = Log(self.cfg.broker_log, "error", "test-http")
        self.backend = create_backend(self.cfg, self.log)
        self.service = HandoffService(self.cfg, self.backend, self.log)
        self.core = McpCore(self.cfg, self.service, self.log)
        self.transport = HttpTransport(self.core, self.cfg, self.log, host="127.0.0.1", port=0)
        self.httpd = self.transport.build_server()
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True).start()
        self.addCleanup(self._shutdown)

    def _shutdown(self):
        try:
            self.httpd.shutdown()
        except Exception:
            pass
        try:
            self.service.close()
        except Exception:
            pass

    def post(self, payload, session_id: str = "", accept: str = "application/json, text/event-stream"):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=30)
        headers = {"Content-Type": "application/json", "Accept": accept}
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        conn.request("POST", "/mcp", json.dumps(payload), headers)
        response = conn.getresponse()
        body = response.read()
        sid = response.getheader("Mcp-Session-Id") or session_id
        parsed = None
        if body:
            text = body.decode("utf-8").strip()
            if text.startswith("data:"):
                parsed = json.loads(text.split("data:", 1)[1].strip().split("\n\n", 1)[0])
            elif text.startswith("{"):
                parsed = json.loads(text)
        conn.close()
        return response.status, parsed, sid

    def test_initialize_and_tools(self):
        status, payload, sid = self.post(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "http-test"}},
            }
        )
        self.assertEqual(status, 200)
        self.assertTrue(sid)
        self.assertIn("严禁使用任何客户端内置", payload["result"]["instructions"])
        status, payload, _ = self.post(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            session_id=sid,
        )
        self.assertEqual(len(payload["result"]["tools"]), 4)
        # 未知会话
        status, payload, _ = self.post(
            {"jsonrpc": "2.0", "id": 3, "method": "tools/list"}, session_id="does-not-exist"
        )
        self.assertEqual(status, 404)

    def test_sse_stream_with_keepalive_and_human_message(self):
        status, payload, sid = self.post(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "sse"}},
            }
        )
        self.assertEqual(status, 200)

        endpoint = BrokerEndpoint(self.home).wait() or self.cfg.endpoint
        human = HumanClient(endpoint)
        # HTTP 模式下 broker 也在同一个进程里（TCP），使用 broker.json 里的 endpoint
        human.connect()
        self.addCleanup(human.close)

        conn = HTTPConnection("127.0.0.1", self.port, timeout=30)
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "human_wait",
                    "arguments": {"keepalive_seconds": 2},
                    "_meta": {"progressToken": "p-1"},
                },
            }
        )
        conn.request(
            "POST",
            "/mcp",
            body,
            {"Content-Type": "application/json", "Accept": "text/event-stream", "Mcp-Session-Id": sid},
        )
        response = conn.getresponse()
        self.assertEqual(response.getheader("Content-Type").split(";")[0], "text/event-stream")

        events = []

        def pump(deadline: float, stop_when=None) -> None:
            while time.time() < deadline:
                line = response.fp.readline()
                if not line:
                    return
                line = line.decode("utf-8").strip()
                if line.startswith("data:"):
                    events.append(json.loads(line[len("data:") :].strip()))
                    if stop_when and stop_when(events[-1]):
                        return

        try:
            # 先等到心跳（证明长等待期间 SSE 没有被掐断）
            pump(time.time() + 6, stop_when=lambda item: item.get("method") == "notifications/progress")
            human.send("HTTP 通道测试")
            # 再等到最终响应
            pump(time.time() + 10, stop_when=lambda item: item.get("id") == 7)
        except (TimeoutError, socket.timeout):
            pass
        methods = [item.get("method") for item in events]
        self.assertIn("notifications/progress", methods, "SSE 期间没有心跳 progress 通知")
        final = [item for item in events if item.get("id") == 7]
        self.assertTrue(final, "SSE 没有返回最终响应")
        self.assertEqual(final[0]["result"]["structuredContent"]["status"], "human_message")
        self.assertEqual(final[0]["result"]["structuredContent"]["message"]["text"], "HTTP 通道测试")

    def test_get_returns_405_and_health_ok(self):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/mcp")
        response = conn.getresponse()
        self.assertEqual(response.status, 405)
        response.read()
        conn.request("GET", "/healthz")
        health = conn.getresponse()
        self.assertEqual(health.status, 200)
        health.read()
        conn.close()


# ---------------------------------------------------------------------------
class UnitTests(unittest.TestCase):
    def test_wrap_and_width(self):
        from humanchat.cli import display_width, wrap_text

        self.assertEqual(display_width("中文"), 4)
        self.assertEqual(display_width("ab"), 2)
        lines = wrap_text("一二三四五", 4)
        self.assertEqual(lines, ["一二", "三四", "五"])

    def test_persistence_across_restart(self):
        home = Path(tempfile.mkdtemp(prefix="humanchat-persist-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        from humanchat.broker import Broker, Log
        from humanchat.config import Config

        cfg = Config(home=str(home))
        cfg.tcp_port = _free_port()  # 别和真实/其他用例的 broker 抢 8790
        cfg.ensure_dirs()
        broker = Broker(cfg, Log(cfg.broker_log, "error"))
        broker.start()
        broker.append_message("default", "agent", "第一轮任务完成", kind="done")
        broker.stop()
        broker2 = Broker(cfg, Log(cfg.broker_log, "error"))
        session = broker2.get_session("default")
        self.assertEqual(len(session.messages), 1)
        self.assertEqual(session.messages[0]["text"], "第一轮任务完成")
        broker2.stop()


if __name__ == "__main__":
    unittest.main(verbosity=2)


# ---------------------------------------------------------------------------
class RemoteBrokerTests(TempHome):
    """人类先起常驻 broker，MCP 以客户端接入（推荐的生产部署方式）。"""

    @unittest.skipUnless(os.name == "posix", "仅 POSIX 守护进程")
    def test_mcp_attaches_to_running_broker(self):
        env = dict(os.environ)
        env["HUMANCHAT_HOME"] = str(self.home)
        env["HUMANCHAT_AUTOLAUNCH"] = "never"
        daemon = subprocess.Popen(
            [sys.executable, ENTRY, "--broker", "--daemon"],
            env=env,
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: daemon.wait(timeout=5))

        endpoint = BrokerEndpoint(self.home).wait(timeout=15)
        self.assertIsNotNone(endpoint, "daemon broker 未启动")

        mcp = StdioMcpClient(self.home, extra_env={"HUMANCHAT_KEEPALIVE_SECONDS": "2"})
        self.addCleanup(mcp.close)
        mcp.call(
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "remote-test"}},
        )
        human = HumanClient(endpoint)
        human.connect()
        self.addCleanup(human.close)

        # MCP 侧发消息 → 人类侧收到
        mcp.call("tools/call", {"name": "human_notify", "arguments": {"text": "来自远程模式的汇报"}})
        event = human.wait_event("message")
        self.assertIsNotNone(event)
        self.assertEqual(event["message"]["text"], "来自远程模式的汇报")

        # 人类侧发消息 → MCP 的 human_wait 收到（RemoteBackend 走 socket 等待）
        thread, box = mcp.call_async("tools/call", {"name": "human_wait", "arguments": {"keepalive_seconds": 10}})
        time.sleep(0.5)
        human.send("远程模式下的提问")
        thread.join(timeout=15)
        self.assertIn("response", box)
        structured = box["response"]["result"]["structuredContent"]
        self.assertEqual(structured["status"], "human_message")
        self.assertEqual(structured["message"]["text"], "远程模式下的提问")

        # 远程模式下 keepalive 同样生效
        keep = mcp.call("tools/call", {"name": "human_wait", "arguments": {"keepalive_seconds": 1}})["result"]
        self.assertEqual(keep["structuredContent"]["status"], "keepalive")

        # 关掉 MCP 不应影响 broker（人类终端继续可用）
        mcp.close()
        self.assertTrue(human.request("ping").get("pong"))


class BacklogTests(TempHome):
    """include_backlog 的消费语义在 local / remote 两种模式下都要正确。"""

    def _check(self, mcp: StdioMcpClient, human: HumanClient) -> None:
        human.send("第一条")
        human.send("第二条")
        time.sleep(0.4)
        status = mcp.call("tools/call", {"name": "human_status", "arguments": {}})["result"]
        self.assertGreaterEqual(status["structuredContent"]["pending_count"], 2)
        backlog = mcp.call(
            "tools/call",
            {"name": "human_status", "arguments": {"include_backlog": True}},
        )["result"]
        texts = [item["text"] for item in backlog["structuredContent"]["messages"]]
        self.assertEqual(texts, ["第一条", "第二条"])
        again = mcp.call("tools/call", {"name": "human_status", "arguments": {}})["result"]
        self.assertEqual(again["structuredContent"]["pending_count"], 0)

    def test_backlog_local(self):
        mcp = StdioMcpClient(self.home)
        self.addCleanup(mcp.close)
        mcp.call(
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "backlog-local"}},
        )
        endpoint = BrokerEndpoint(self.home).wait()
        self.assertIsNotNone(endpoint)
        human = HumanClient(endpoint)
        human.connect()
        self.addCleanup(human.close)
        self._check(mcp, human)

    @unittest.skipUnless(os.name == "posix", "仅 POSIX 守护进程")
    def test_backlog_remote(self):
        env = dict(os.environ)
        env["HUMANCHAT_HOME"] = str(self.home)
        daemon = subprocess.Popen(
            [sys.executable, ENTRY, "--broker", "--daemon"],
            env=env, cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: daemon.wait(timeout=5))
        endpoint = BrokerEndpoint(self.home).wait(timeout=15)
        self.assertIsNotNone(endpoint)
        mcp = StdioMcpClient(self.home)
        self.addCleanup(mcp.close)
        mcp.call(
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "backlog-remote"}},
        )
        human = HumanClient(endpoint)
        human.connect()
        self.addCleanup(human.close)
        self._check(mcp, human)
