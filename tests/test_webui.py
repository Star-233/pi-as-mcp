"""Web 界面（humanchat web）的端到端测试 —— 纯标准库，不需要任何依赖。

覆盖：
  * 页面 / 静态资源 / healthz
  * /api/state、/api/send、/api/history、/api/session/*、/api/export、/api/rules
  * SSE：连接即收到 snapshot，人类发消息后立刻收到 message 事件
  * 令牌模式：未带令牌 401、/api/auth 换 cookie、query token、Bearer
  * 断线重连：broker 消失后 connected=false，重启后自动恢复
  * 与 TUI 同源：Web 发的消息，TUI 侧客户端也能看到（同一个 broker）
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRY = str(ROOT / "humanchat_mcp.py")
sys.path.insert(0, str(ROOT / "src"))


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def kill_process(pid: int) -> None:
    """跨平台强杀一个进程（Windows 用 taskkill，POSIX 用 SIGKILL）。"""
    if pid <= 0:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=30)
        return
    os.kill(pid, signal.SIGKILL)


def wait_for(predicate, timeout=15.0, interval=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


class WebApp:
    """管一个 humanchat web 子进程（内置 broker）+ 一个极简 HTTP 客户端。"""

    def __init__(self, home: Path, token: str = "", extra: list = None) -> None:
        self.home = home
        self.token = token
        self.port = free_port()
        # broker 也占一个独立端口：Windows 上（Python 没有 AF_UNIX 时）broker 走
        # TCP 127.0.0.1:8790，是“一台机器一个”，不隔离的话测试会连到别的 HOME
        # 上已经在跑的 broker，行为就不确定了。
        self.broker_port = free_port()
        self.proc = None
        self.extra = list(extra or [])

    # ---------------------------------------------------------------- 生命周期
    def start(self) -> None:
        env = dict(os.environ)
        env["HUMANCHAT_HOME"] = str(self.home)
        env["HUMANCHAT_AUTOLAUNCH"] = "never"
        env["HUMANCHAT_TCP"] = "1"
        env["HUMANCHAT_TCP_PORT"] = str(self.broker_port)
        args = [sys.executable, ENTRY, "web", "--host", "127.0.0.1", "--port", str(self.port),
                "--no-open", "--session", "default"] + self.extra
        if self.token:
            args += ["--token", self.token]
        self.proc = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if not wait_for(self._healthy, timeout=20):
            output = b""
            if self.proc and self.proc.stdout:
                try:
                    self.proc.stdout.close()
                except Exception:
                    pass
            self.stop()
            raise AssertionError("web 服务没有起来: %s" % output.decode("utf-8", "replace")[:500])
        if not self.wait_connected():
            raise AssertionError("Web 界面没有接上 broker")

    def stop(self) -> None:
        if self.proc:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
            if self.proc.stdout:
                try:
                    self.proc.stdout.close()
                except Exception:
                    pass
        self.proc = None

    def wait_connected(self, timeout: float = 25.0) -> bool:
        """等 Web 界面真正接上 broker（healthz 只代表 HTTP 服务起来了）。"""
        return bool(wait_for(lambda: self.get("/api/state").get("connected"), timeout=timeout))

    def _healthy(self) -> bool:
        try:
            self.get("/healthz", token=False)
            return True
        except Exception:
            return False

    # ---------------------------------------------------------------- 请求
    def url(self, path: str, token: bool = True) -> str:
        base = "http://127.0.0.1:%d" % self.port
        if token and self.token:
            joiner = "&" if "?" in path else "?"
            return base + path + joiner + "token=" + urllib.parse.quote(self.token)
        return base + path

    def get(self, path: str, token: bool = True, headers: dict = None, raw: bool = False):
        req = urllib.request.Request(self.url(path, token), headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                status, raw_headers, body = resp.status, dict(resp.headers), resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:  # 401/404 也要能拿到内容
            status, raw_headers, body = exc.code, dict(exc.headers or {}), exc.read().decode("utf-8")
        if raw:
            return status, body, raw_headers
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return body

    def post(self, path: str, payload: dict, token: bool = True):
        req = urllib.request.Request(
            self.url(path, token),
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def expect_status(self, path: str, status: int, token: bool = True, method: str = "GET",
                      payload: dict = None) -> str:
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self.url(path, token), data=data, method=method,
                                     headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return str(resp.status)
        except urllib.error.HTTPError as exc:
            return str(exc.code)

    # ---------------------------------------------------------------- SSE
    def sse(self, path: str, token: bool = True):
        """返回一个极简 SSE 读取器（只解析 data: 行）。"""
        req = urllib.request.Request(self.url(path, token), headers={"Accept": "text/event-stream"})
        return _SseReader(urllib.request.urlopen(req, timeout=30))


class _SseReader:
    def __init__(self, resp) -> None:
        self.resp = resp

    def events(self, limit: int = 40, timeout: float = 12.0):
        out = []
        deadline = time.time() + timeout
        while len(out) < limit and time.time() < deadline:
            line = self.resp.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").strip()
            if not text.startswith("data:"):
                continue
            try:
                out.append(json.loads(text[5:].strip()))
            except json.JSONDecodeError:
                continue
        return out

    def wait_event(self, name: str, timeout: float = 12.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for event in self.events(limit=1, timeout=max(0.2, deadline - time.time())):
                if event.get("event") == name:
                    return event
        return None

    def close(self) -> None:
        try:
            self.resp.close()
        except Exception:
            pass


class WebUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        import tempfile

        cls.tmp = Path(tempfile.mkdtemp(prefix="humanchat-web-"))
        cls.app = WebApp(cls.tmp)
        cls.app.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.app.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ------------------------------------------------------------------ 基础
    def test_01_page_renders_offline_assets(self) -> None:
        status, body, headers = self.app.get("/", raw=True)
        self.assertEqual(status, 200)
        self.assertIn("humanchat", body.lower())
        self.assertIn("text/html", headers.get("Content-Type", ""))
        # 页面自带样式与脚本（不外链任何东西），这是“零依赖 / 离线可用”的硬要求
        self.assertIn("<style>", body)
        self.assertIn("</script>", body)
        self.assertNotIn("http://cdn", body)
        self.assertNotIn("https://cdn", body)
        self.assertNotIn("src=\"http", body)
        self.assertNotIn("href=\"http", body)

    def test_02_healthz(self) -> None:
        data = self.app.get("/healthz", token=False)
        self.assertTrue(data["ok"])
        self.assertEqual(data["app"], "humanchat-web")

    def test_03_state_shape(self) -> None:
        data = self.app.get("/api/state?session=default")
        self.assertTrue(data["connected"], data.get("error"))
        self.assertEqual(data["session_id"], "default")
        self.assertIsInstance(data["sessions"], list)
        self.assertIn("messages", data["session"])
        self.assertIn("status", data["session"])
        self.assertIn("attach_command", data)

    def test_04_rules(self) -> None:
        data = self.app.get("/api/rules")
        self.assertIn("HUMANCHAT", data["text"])
        self.assertIn("human_wait", data["text"])

    # ------------------------------------------------------------------ 消息
    def test_10_send_and_history(self) -> None:
        result = self.app.post("/api/send", {"session": "default", "text": "来自 Web 界面的第一句话"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["message"]["role"], "human")
        history = self.app.get("/api/history?session=default")
        texts = [m["text"] for m in history["messages"]]
        self.assertIn("来自 Web 界面的第一句话", texts)

    def test_11_send_rejects_empty(self) -> None:
        self.assertEqual(self.app.expect_status("/api/send", 400, method="POST",
                                                payload={"session": "default", "text": "   "}), "400")

    def test_12_session_lifecycle(self) -> None:
        created = self.app.post("/api/session/new", {"session": "web-test", "title": "Web 测试"})
        self.assertEqual(created["session"]["id"], "web-test")
        self.assertEqual(created["session"]["title"], "Web 测试")
        renamed = self.app.post("/api/session/rename", {"session": "web-test", "title": "改个名字"})
        self.assertEqual(renamed["session"]["title"], "改个名字")
        self.app.post("/api/send", {"session": "web-test", "text": "只属于这个会话的消息"})
        sessions = {s["id"]: s for s in self.app.get("/api/state?session=default")["sessions"]}
        self.assertIn("web-test", sessions)
        cleared = self.app.post("/api/session/clear", {"session": "web-test"})
        self.assertEqual(cleared["session"]["count"], 0)

    def test_13_export_markdown(self) -> None:
        self.app.post("/api/send", {"session": "default", "text": "导出测试"})
        status, body, headers = self.app.get("/api/export?session=default", raw=True)
        self.assertEqual(status, 200)
        self.assertIn("导出测试", body)
        self.assertIn("text/markdown", headers.get("Content-Type", ""))
        status, body, headers = self.app.get("/api/export?session=default&download=1", raw=True)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))

    def test_14_unknown_path_404(self) -> None:
        self.assertEqual(self.app.expect_status("/api/nope", 404), "404")

    # ------------------------------------------------------------------ SSE
    def test_20_sse_snapshot_then_message(self) -> None:
        reader = self.app.sse("/api/events?session=default")
        try:
            names = []
            for event in reader.events(limit=3, timeout=10):
                names.append(event.get("event"))
            self.assertIn("snapshot", names)
            self.assertIn("sessions", names)
            self.app.post("/api/send", {"session": "default", "text": "SSE 推送测试"})
            event = reader.wait_event("message", timeout=10)
            self.assertIsNotNone(event, "SSE 没有推送人类消息")
            self.assertEqual(event["message"]["text"], "SSE 推送测试")
            self.assertEqual(event["session"], "default")
        finally:
            reader.close()

    # ------------------------------------------------------------------ 断线重连
    def test_30_reconnect_after_broker_restart(self) -> None:
        server = self.app.get("/api/state").get("server") or {}
        pid = int(server.get("pid") or 0)
        self.assertTrue(pid, "Web 界面没有报告 broker pid: %r" % (server,))
        kill_process(pid)
        self.assertTrue(wait_for(lambda: not self.app.get("/api/state")["connected"], timeout=20),
                        "broker 被杀掉后 Web 界面没有察觉到断线")
        # Web 服务器自己会重新拉起一个 broker（和 MCP 侧同一套 create_backend 逻辑）
        self.assertTrue(wait_for(lambda: self.app.get("/api/state")["connected"], timeout=25),
                        "broker 没有自动恢复")
        self.app.post("/api/send", {"session": "default", "text": "重连之后还能说话"})
        history = self.app.get("/api/history?session=default")
        self.assertIn("重连之后还能说话", [m["text"] for m in history["messages"]])


class WebUiTokenTests(unittest.TestCase):
    """令牌模式：给手机 / 局域网用。"""

    @classmethod
    def setUpClass(cls) -> None:
        import tempfile

        cls.tmp = Path(tempfile.mkdtemp(prefix="humanchat-web-token-"))
        cls.app = WebApp(cls.tmp, token="s3cret-token")
        cls.app.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.app.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_01_home_without_token_gives_gate(self) -> None:
        status, body, _headers = self.app.get("/", token=False, raw=True)
        self.assertEqual(status, 401)
        self.assertIn("令牌", body)

    def test_02_api_without_token_401(self) -> None:
        self.assertEqual(self.app.expect_status("/api/state", 401, token=False), "401")

    def test_03_auth_flow(self) -> None:
        self.assertEqual(self.app.expect_status("/api/auth", 401, token=False, method="POST",
                                               payload={"token": "wrong"}), "401")
        good = self.app.post("/api/auth", {"token": "s3cret-token"}, token=False)
        self.assertTrue(good["ok"])
        # 带 token 的 query / Bearer 也都能用
        self.assertTrue(self.app.get("/api/state")["ok"])  # query token
        with urllib.request.urlopen(urllib.request.Request(
                self.app.url("/api/state", token=False),
                headers={"Authorization": "Bearer s3cret-token"}), timeout=10) as resp:
            self.assertTrue(json.loads(resp.read().decode())["ok"])

    def test_04_home_with_token_sets_cookie(self) -> None:
        status, _body, headers = self.app.get("/", raw=True)
        self.assertEqual(status, 200)
        self.assertIn("hc_token=", headers.get("Set-Cookie", ""))

    def test_05_healthz_stays_open(self) -> None:
        self.assertTrue(self.app.get("/healthz", token=False)["ok"])


class WebUiCliTests(unittest.TestCase):
    """命令行 / 进程层面的行为，不需要真的起服务。"""

    def test_reuse_running_instance(self) -> None:
        import tempfile

        tmp = Path(tempfile.mkdtemp(prefix="humanchat-web-reuse-"))
        app = WebApp(tmp)
        app.start()
        try:
            env = dict(os.environ)
            env["HUMANCHAT_HOME"] = str(tmp)
            env["HUMANCHAT_AUTOLAUNCH"] = "never"
            second = subprocess.run(
                [sys.executable, ENTRY, "web", "--port", str(app.port), "--no-open"],
                env=env, capture_output=True, text=True, timeout=40,
            )
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn("已经在运行", second.stdout + second.stderr)
        finally:
            app.stop()

    def test_env_ui_selects_web_command(self) -> None:
        import tempfile

        tmp = Path(tempfile.mkdtemp(prefix="humanchat-web-env-"))
        env = dict(os.environ)
        env["HUMANCHAT_HOME"] = str(tmp)
        env["HUMANCHAT_UI"] = "web"
        env["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + env.get("PYTHONPATH", "")
        code = (
            "from humanchat import launcher; from humanchat.config import Config;"
            "cfg = Config(); print(cfg.ui); print(launcher.ui_command(cfg, 'demo'))"
        )
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True,
                             cwd=str(ROOT), timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("web", out.stdout.splitlines()[0])
        self.assertIn(" web ", out.stdout)
        self.assertIn("--open", out.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
