"""连一台**外面在跑的** MCP 服务器。

这里的服务器是假的，但它说的是真的协议。三条最要紧的：

- **工具清单是问出来的**，不是谁声明的
- **答复要按 `id` 配对**——服务器插一条通知进来，管道不能错位
- **服务器说"这个工具报错了"要被当成错误**，不能伪装成一次成功的调用
"""
from __future__ import annotations

import pytest

from src.extensions.mcp_client import McpError, connect
from tests.support.mcpserver import FakeMcpServer


def test_连上去并识别出它有什么():
    with FakeMcpServer() as server:
        connection = connect(server.url)
        tools = connection.list_tools()

        assert connection.alive is True
        assert [t.name for t in tools] == ["search"]
        assert tools[0].description == "搜索工作区"
        assert tools[0].input_schema["required"] == ["q"]
        connection.close()


def test_清单是从服务器读的_不是猜的():
    with FakeMcpServer(tools=[{"name": "别的东西", "description": "",
                               "inputSchema": {"type": "object"}}]) as server:
        connection = connect(server.url)

        assert [t.name for t in connection.list_tools()] == ["别的东西"]
        connection.close()


def test_服务器的中文没被编码弄坏():
    """JSON-RPC 的线上编码是 UTF-8。不显式指定时 Windows 会按码页解，中文全乱。"""
    with FakeMcpServer() as server:
        connection = connect(server.url)

        assert connection.list_tools()[0].description == "搜索工作区"
        connection.close()


def test_调用走的是_tools_call():
    with FakeMcpServer() as server:
        connection = connect(server.url)
        answer = connection.call_tool("search", {"q": "季度报告"})

        assert answer[0]["text"] == "search: 季度报告"
        assert "tools/call" in server.seen_methods
        connection.close()


def test_一条通知插在答复前面_管道不能错位():
    """**这一条是旧实现的病灶。**

    它是"发一条、读一行"，读回来的不管是不是自己那条——服务器发一条
    `notifications/tools/list_changed`，它就把通知当成答复，**安静地返回一个空字典**，
    真正的答复留在后面，之后每一条都错位一格。

    新客户端按 JSON-RPC 的 `id` 配对：不是自己那条就跳过，继续等。
    """
    with FakeMcpServer() as server:
        server.reply_mode = "notification_first"
        connection = connect(server.url)

        tools = connection.list_tools()

        assert [t.name for t in tools] == ["search"], "通知被当成了答复"
        connection.close()


def test_服务器说工具报错_就是报错():
    with FakeMcpServer() as server:
        server.reply_mode = "iserror"
        connection = connect(server.url)

        with pytest.raises(McpError) as caught:
            connection.call_tool("search", {"q": "x"})

        assert "文件不存在" in str(caught.value)
        connection.close()


def test_对面不是_MCP_服务器_当场说清():
    """一个只会说 HTTP 的东西，握手就过不去——**不能假装连上了**。"""
    with FakeMcpServer() as server:
        server.reply_mode = "garbage"

        with pytest.raises(McpError):
            connect(server.url, timeout=1.0)


def test_连不上要大声说出来():
    """**"它没起"是常态**——但不能是静默的常态。"""
    with pytest.raises(McpError):
        connect("http://127.0.0.1:1/mcp", timeout=0.5)


def test_没有_url就没什么可连的():
    with pytest.raises(McpError):
        connect("")


def test_关掉之后就不再是活的():
    with FakeMcpServer() as server:
        connection = connect(server.url)
        connection.close()

        assert connection.alive is False
