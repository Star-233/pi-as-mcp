#!/usr/bin/env python3
"""模拟一个“守规矩的 Agent”：干完活不停，而是循环 human_wait 等人类说话。

用途：不需要 AgentDock 也能本地体验完整链路。

终端 1（人类）：
    python3 humanchat_mcp.py attach

终端 2（假装自己是 Agent）：
    python3 examples/demo_agent.py

脚本会：
  1. 以 stdio 启动 HumanChat MCP 服务器（等价于 AgentDock 的 transport=stdio）；
  2. initialize，打印收到的强制规则摘要；
  3. human_notify(kind="done", then_wait=true, keepalive_seconds=6) 汇报一个假任务；
  4. 循环处理返回值：keepalive → 立刻再次 human_wait；human_message → “回答”人类再继续；
  5. 当人类发来的话里出现“结束 / exit / bye”时，按规则收尾退出。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRY = str(ROOT / "humanchat_mcp.py")
KEEPALIVE = float(os.environ.get("DEMO_KEEPALIVE", "6"))
STOP_WORDS = ("结束", "退出", "不用了", "exit", "quit", "bye", "stop")


class McpStdioClient:
    """极简 JSON-RPC over stdio 客户端（只为演示，真实客户端请用官方 SDK）。"""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, ENTRY, "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=dict(os.environ),
            cwd=str(ROOT),
        )
        self.counter = 0
        self.lock = threading.Lock()
        self.responses: dict = {}
        self.ready = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        for raw in self.proc.stdout:
            try:
                message = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            if "id" in message:
                with self.lock:
                    self.responses[message["id"]] = message
                    self.ready.set()

    def call(self, method: str, params: dict = None, notify: bool = False):
        if notify:
            payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
            self.proc.stdin.write((json.dumps(payload) + "\n").encode())
            self.proc.stdin.flush()
            return None
        self.counter += 1
        request_id = self.counter
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        while True:
            self.ready.wait(0.25)
            with self.lock:
                if request_id in self.responses:
                    return self.responses.pop(request_id)
                self.ready.clear()

    def tool(self, name: str, arguments: dict) -> dict:
        response = self.call("tools/call", {"name": name, "arguments": arguments})
        return response.get("result", {})


def main() -> int:
    client = McpStdioClient()
    init = client.call(
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "demo-agent"}},
    )["result"]
    print("=" * 72)
    print("已连接 HumanChat MCP · 服务端名字: %s" % init["serverInfo"]["name"])
    rules = init.get("instructions", "")
    print("收到强制规则 %d 字符（首行）：%s" % (len(rules), rules.splitlines()[0]))
    print("=" * 72)
    client.call("notifications/initialized", {}, notify=True)

    summary = (
        "✅ 演示任务已完成：\n"
        "· 备份 /etc/nginx/nginx.conf\n"
        "· 校验配置语法 nginx -t → OK\n"
        "· 回滚点：/etc/nginx/backup-20261003\n"
        "\n（我是模拟 Agent：现在开始 human_wait 循环，等你在另一个终端里说话）"
    )

    result = client.tool(
        "human_notify",
        {"text": summary, "kind": "done", "then_wait": True, "keepalive_seconds": KEEPALIVE},
    )
    loops = 0
    while True:
        structured = result.get("structuredContent") or {}
        status = structured.get("status")
        text = (result.get("content") or [{}])[0].get("text", "")
        if status == "human_message":
            human_text = (structured.get("message") or {}).get("text", "")
            print("\n🧑 人类说：%s" % human_text)
            if any(word in human_text.lower() for word in STOP_WORDS):
                print("收到结束信号 → 按规则允许结束对话。再见！")
                return 0
            result = client.tool(
                "human_notify",
                {
                    "text": "🤖 收到。演示 Agent 已处理你的问题：「%s」\n（继续等你说话）" % human_text[:60],
                    "kind": "note",
                    "then_wait": True,
                    "keepalive_seconds": KEEPALIVE,
                },
            )
            continue
        if status == "keepalive":
            loops += 1
            print("⏳ keepalive #%d（服务端仍在等待，立刻再次 human_wait —— 这不是超时）" % loops)
            result = client.tool("human_wait", {"keepalive_seconds": KEEPALIVE, "reason": "等人类的下一句话"})
            continue
        if status == "cancelled":
            print("⚠️ 调用被取消，立刻重试 human_wait（消息不会丢）")
            result = client.tool("human_wait", {"keepalive_seconds": KEEPALIVE})
            continue
        print("其它返回：%s" % text[:200])
        result = client.tool("human_wait", {"keepalive_seconds": KEEPALIVE})


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n（演示结束）")
