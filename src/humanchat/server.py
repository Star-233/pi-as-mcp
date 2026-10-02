"""进程入口：MCP 服务器（stdio / HTTP）、独立 broker、守护进程。

  python3 humanchat_mcp.py                 # 无参数且 stdin 是终端 → 打开人类界面
  python3 humanchat_mcp.py --stdio         # MCP stdio（AgentDock transport=stdio 用这个）
  python3 humanchat_mcp.py --http          # MCP streamable HTTP（默认 127.0.0.1:8791/mcp）
  python3 humanchat_mcp.py --ui web        # 让 Agent 自动打开的是浏览器界面
  python3 humanchat_mcp.py --broker        # 只跑 broker（人类可先开终端等 Agent）
  python3 humanchat_mcp.py --broker --daemon   # 后台常驻 broker
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
import time
from typing import List, Optional

from . import __version__, cli
from .backend import HandoffService, create_backend
from .broker import Broker, Log
from .config import Config
from .mcp_core import McpCore
from .transports import HttpTransport, StdioTransport


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="humanchat-mcp",
        description="HumanChat MCP：让 Agent 停下来等人类说话（默认永久不超时）",
    )
    parser.add_argument("--stdio", action="store_true", help="以 stdio 方式运行 MCP 服务器（默认）")
    parser.add_argument("--http", action="store_true", help="以 streamable HTTP 方式运行 MCP 服务器")
    parser.add_argument("--host", default=None, help="HTTP 监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=None, help="HTTP 监听端口（默认 8791）")
    parser.add_argument("--broker", action="store_true", help="只运行 broker（不提供 MCP 工具）")
    parser.add_argument("--daemon", action="store_true", help="配合 --broker：后台常驻运行")
    parser.add_argument("--session", default=None, help="默认会话 id")
    parser.add_argument("--ui", choices=("tui", "web"), default=None,
                        help="人类界面形态：tui（终端，默认）或 web（浏览器）。"
                             "也可以用环境变量 HUMANCHAT_UI")
    parser.add_argument("--no-launch", action="store_true", help="禁用自动打开人类终端")
    parser.add_argument("--version", action="store_true", help="打印版本")
    return parser


def _daemonize(cfg: Config, log: Log) -> None:
    """POSIX：双 fork 脱离终端；Windows：直接以分离进程重启。"""
    if os.name == "nt":  # pragma: no cover
        import subprocess

        args = [sys.executable, os.path.abspath(sys.argv[0]), "--broker"]
        subprocess.Popen(args, creationflags=0x00000008 | 0x00000200, close_fds=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        print("broker 已在后台启动")
        raise SystemExit(0)
    if os.fork() > 0:
        raise SystemExit(0)
    os.setsid()
    if os.fork() > 0:
        raise SystemExit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)


def run_broker_only(cfg: Config, log: Log, daemon: bool = False) -> int:
    from .broker import find_endpoint

    endpoint = find_endpoint(cfg)
    if endpoint:
        log.info("已存在 broker（%s），无需重复启动" % endpoint)
        if not daemon:
            print("broker 已在运行：%s" % endpoint)
        return 0
    if daemon:
        _daemonize(cfg, log)
    broker = Broker(cfg, log)
    try:
        broker.start()
    except ConnectionError:
        # 竞争失败：说明别人已经起来了
        print("broker 已在运行：%s" % (find_endpoint(cfg) or cfg.endpoint))
        return 0
    print("broker 已启动：%s" % broker.endpoint())
    print("人类终端接入： humanchat attach   （或 humanchat_mcp.py attach）")
    stop = threading.Event()

    def shutdown(*_args: object) -> None:
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, shutdown)
        except (ValueError, OSError):
            pass
    try:
        while not stop.is_set():
            time.sleep(0.3)
    finally:
        broker.stop()
    return 0


def run_mcp(cfg: Config, log: Log, use_http: bool, host: Optional[str], port: Optional[int]) -> int:
    backend = create_backend(cfg, log)
    service = HandoffService(cfg, backend, log)
    core = McpCore(cfg, service, log)
    log.info(
        "HumanChat MCP v%s 启动 · broker=%s · keepalive=%ss · autolaunch=%s"
        % (__version__, backend.mode, cfg.keepalive_seconds, cfg.autolaunch)
    )

    stop = threading.Event()

    def shutdown(*_args: object) -> None:
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, shutdown)
        except (ValueError, OSError):
            pass

    try:
        if use_http:
            transport = HttpTransport(core, cfg, log, host=host, port=port)

            def watch() -> None:
                while not stop.is_set():
                    time.sleep(0.4)
                transport.stop()

            threading.Thread(target=watch, name="http-watchdog", daemon=True).start()
            transport.run()
        else:
            stdio = StdioTransport(core, log)
            threading.Thread(target=lambda: (stop.wait(), None), name="noop", daemon=True)
            stdio.run()
    finally:
        service.close()
        log.info("HumanChat MCP 退出")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # 人类侧子命令直接交给 CLI
    if argv and argv[0] in cli.COMMANDS:
        return cli.main(argv)

    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print("humanchat-mcp %s" % __version__)
        return 0

    cfg = Config()
    if args.session:
        cfg.default_session = args.session
    if args.ui:
        cfg.ui = args.ui
    if args.no_launch:
        cfg.autolaunch = "never"
    cfg.ensure_dirs()
    log = Log(cfg.broker_log, cfg.log_level, "humanchat")

    # 无参数 + 交互式终端 → 打开人类界面（对“人类先来等 Agent”很友好）
    if not argv and sys.stdin.isatty() and sys.stdout.isatty():
        print("没有参数且处于终端环境 → 打开人类界面；如需 MCP 服务请用 --stdio 或 --http")
        return cli.main(["attach"])

    if args.broker:
        return run_broker_only(cfg, log, daemon=args.daemon)
    return run_mcp(cfg, log, use_http=args.http, host=args.host, port=args.port)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
