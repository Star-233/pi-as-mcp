
MCP（公网）: {{PUBLIC_MCP}}
请求头: Authorization: Bearer {{BEARER}}
先通过脚本连接MCP，然后先读agentdock_context再用mcp_tool_search读humanchat。
接着，用humanchat和我对话。

会话固定 session_id="{{SESSION}}"，写错我这边看不见你。
注意：动态 server 冷启动慢，首次调用可能要 30-60 秒，客户端超时请设 ≥90 秒。
