# OCC 外部 MCP 连接样例

这里的服务故意位于 `occ-next` 外部。OCC 只连接、发现和验证 MCP，不把这些工具内置为 OCC Provider。

运行方式（在项目根目录）：

```powershell
uv run --project occ-next python occ-mcp-examples\echo_server.py
uv run --project occ-next python occ-mcp-examples\workspace_server.py
```

它们都是 stdio MCP server，由 MCP client 启动后通过 stdin/stdout 通信。
