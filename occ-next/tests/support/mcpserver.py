"""一个说 MCP-over-HTTP 的**假服务器**。

它不是 MCP 的完整实现，也不打算是——它只负责把客户端**会读到的那几种答复形状**
造出来，包括两种让客户端出错的：**通知插在答复前面**、**服务器说工具报错**。

用它当上下文管理器：

```python
with FakeMcpServer() as server:
    connection = connect(server.url)
```
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

#: 默认它"有"的工具。schema 是 `tools/list` 给的，不是谁声明的。
DEFAULT_TOOLS: list[dict[str, Any]] = [
    {"name": "search", "description": "搜索工作区",
     "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}},
                     "required": ["q"]}},
]


class FakeMcpServer:
    def __init__(self, tools: list[dict[str, Any]] | None = None) -> None:
        self.tools = list(DEFAULT_TOOLS if tools is None else tools)
        #: `json` = 一次性 JSON；`notification_first` = 先来一条通知再给答复；
        #: `iserror` = 工具自己说它失败了
        self.reply_mode = "json"
        self.session_id = "sess-123"
        self.seen_methods: list[str] = []
        self._server = HTTPServer(("127.0.0.1", 0), _handler_for(self))
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}/mcp"

    def __enter__(self) -> "FakeMcpServer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def _handler_for(server: FakeMcpServer) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: Any) -> None:      # 别把测试输出搞脏
            pass

        def _send(self, code: int, body: str | bytes,
                  ctype: str = "application/json", extra: dict[str, str] | None = None) -> None:
            raw = body.encode("utf-8") if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(raw)))
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(raw)

        def _result(self, message_id: Any, result: Any) -> None:
            self._send(200, json.dumps({"jsonrpc": "2.0", "id": message_id, "result": result},
                                       ensure_ascii=False))

        def do_DELETE(self) -> None:
            """会话结束。**必须答一声**——不答，客户端每次收尾都会警告一句。"""
            server.seen_methods.append("DELETE")
            self._send(200, b"")

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            message = json.loads(self.rfile.read(length).decode("utf-8"))
            method = message.get("method") or ""
            server.seen_methods.append(method)

            if server.reply_mode == "garbage":
                # 一个只会说 HTTP 的东西：答得出 200，但答的不是 MCP。
                return self._send(200, json.dumps({"hello": "world"}))

            if method == "initialize":
                handshake = {"protocolVersion": "2025-03-26", "capabilities": {},
                             "serverInfo": {"name": "fake", "version": "1"}}
                return self._send(200, json.dumps({"jsonrpc": "2.0", "id": message["id"],
                                                   "result": handshake}),
                                  extra={"Mcp-Session-Id": server.session_id})

            if "id" not in message:                    # 通知：按协议回 202 且没有 body
                return self._send(202, b"")

            if method == "tools/list":
                result = {"tools": server.tools}
                if server.reply_mode == "notification_first":
                    # **旧实现就是在这一条上错位的**：它读一行当答复，读到的是这条通知。
                    return self._send(200, (
                        "event: message\n"
                        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'
                        "\n"
                        "event: message\n"
                        f"data: {json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}, ensure_ascii=False)}\n"
                        "\n"), ctype="text/event-stream")
                return self._result(message["id"], result)

            if method == "tools/call":
                arguments = (message.get("params") or {}).get("arguments") or {}
                if server.reply_mode == "iserror":
                    return self._result(message["id"], {
                        "isError": True, "content": [{"type": "text", "text": "文件不存在"}]})
                name = (message.get("params") or {}).get("name")
                return self._result(message["id"], {
                    "content": [{"type": "text", "text": f"{name}: {arguments.get('q', '')}"}]})

            return self._send(200, json.dumps({
                "jsonrpc": "2.0", "id": message["id"],
                "error": {"code": -32601, "message": f"没有这个方法: {method}"}}))

    return Handler
