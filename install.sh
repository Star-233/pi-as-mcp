#!/usr/bin/env bash
# HumanChat MCP 安装助手。
#
#   ./install.sh                     # 安装到 ~/.local/share/humanchat-mcp，并打印 AgentDock 注册配置
#   ./install.sh --prefix /opt/humanchat-mcp
#   ./install.sh --daemon            # 额外启动常驻 broker（人类界面不随 AgentDock 重启而断开）
#   ./install.sh --systemd           # 额外安装 systemd --user 服务
#   ./install.sh --link              # 用软链接而不是拷贝（便于从源码目录使用）
#
# 安装完成后，把打印出来的 JSON 交给 AgentDock：mcp_manage action=add …
set -euo pipefail

PREFIX="${HOME}/.local/share/humanchat-mcp"
DAEMON=0
SYSTEMD=0
LINK=0
PYTHON="${PYTHON:-python3}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --daemon) DAEMON=1; shift ;;
    --systemd) SYSTEMD=1; shift ;;
    --link) LINK=1; shift ;;
    --python) PYTHON="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> 检查 Python"
command -v "$PYTHON" >/dev/null 2>&1 || { echo "找不到 $PYTHON，请先安装 Python 3.8+"; exit 1; }
"$PYTHON" - <<'PY'
import sys
if sys.version_info < (3, 8):
    raise SystemExit("需要 Python 3.8+，当前为 %s" % sys.version.split()[0])
print("    Python", sys.version.split()[0], "OK")
PY

echo "==> 安装到 $PREFIX"
mkdir -p "$PREFIX"
if [ "$LINK" = "1" ]; then
  ln -sfn "$SRC/humanchat_mcp.py" "$PREFIX/humanchat_mcp.py"
  ln -sfn "$SRC/src" "$PREFIX/src"
else
  cp -f "$SRC/humanchat_mcp.py" "$PREFIX/humanchat_mcp.py"
  rm -rf "$PREFIX/src"
  cp -R "$SRC/src" "$PREFIX/src"
  cp -f "$SRC/README.md" "$PREFIX/README.md" 2>/dev/null || true
fi
chmod +x "$PREFIX/humanchat_mcp.py"

ENTRY="$PREFIX/humanchat_mcp.py"
"$PYTHON" "$ENTRY" --version

if [ "$DAEMON" = "1" ]; then
  echo "==> 启动常驻 broker"
  "$PYTHON" "$ENTRY" --broker --daemon || true
  "$PYTHON" "$ENTRY" status || true
fi

if [ "$SYSTEMD" = "1" ]; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/humanchat.service" <<EOF
[Unit]
Description=HumanChat broker (human-in-the-loop terminal)
After=network.target

[Service]
ExecStart=$PYTHON $ENTRY --broker
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  echo "==> 已写入 $UNIT_DIR/humanchat.service"
  echo "    systemctl --user daemon-reload && systemctl --user enable --now humanchat"
fi

cat <<EOF

=====================================================================
安装完成 ✅

人类打开终端界面：
    $PYTHON $ENTRY attach

交给 AgentDock 的注册配置（把它发给 Agent，或让 Agent 用 mcp_manage 执行）：

{
  "action": "add",
  "name": "humanchat",
  "description": "人类在环终端对话：任务结束后等待人类提问",
  "transport": "stdio",
  "command": "$PYTHON",
  "args": ["$ENTRY", "--stdio"],
  "timeout_ms": 300000,
  "enabled": true
}

随后执行 mcp_manage 的 refresh，再用 mcp_tool_search 搜 "human" 验证 4 个工具已就绪。
=====================================================================
EOF
