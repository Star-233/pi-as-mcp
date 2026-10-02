#!/usr/bin/env python3
"""HumanChat MCP —— 单文件入口（AgentDock 注册 stdio MCP 时就指向这个文件）。

  AgentDock / 任意 MCP 客户端：
      python3 /path/to/humanchat-mcp/humanchat_mcp.py            # stdio MCP（默认）

  人类终端：
      python3 /path/to/humanchat-mcp/humanchat_mcp.py attach     # 打开对话界面
      python3 /path/to/humanchat-mcp/humanchat_mcp.py send "继续"  # 直接发一句
      python3 /path/to/humanchat-mcp/humanchat_mcp.py status

零依赖：只用 Python 3.8+ 标准库，不需要 pip install。
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = os.path.join(_HERE, "src")
if os.path.isdir(_SRC) and _SRC not in sys.path:
    sys.path.insert(0, _SRC)

# 保证本地包优先于任何同名安装（避免版本串味）
try:
    from humanchat import __version__ as _version  # noqa: F401
    from humanchat.server import main as _main
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        "无法导入 humanchat 包：%r\n请确认 humanchat_mcp.py 与 src/ 目录在一起，"
        "或者使用 pip install -e . 安装。\n" % (exc,)
    )
    raise SystemExit(2)


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
