"""**只管 MCP**：连上、问它有什么、调一次。

它服务的是**外部**的 MCP 服务器（`tools` 条目里的 `url` 那种）。包内的实现不经过它——
那是 `tools.py` 里实例化出来的单例，调用就是一次普通函数调用。

**协议不归我们写。** 连接、握手、会话、SSE、`id` 配对、UTF-8——全在 `fastmcp` 那个
客户端库里。这一层只做三件事，都是库不管的：

| 它管什么 | 为什么在这里 |
| --- | --- |
| 同步/异步的桥 | 调用方是同步的；库是 async 的 |
| **超时** | "它没起"是常态，不能让一台服务器挡住别的包 |
| 把失败说成人话（`McpError`） | 上层拿它去记一条诊断，不是崩掉 |

**它不启进程**：外面的服务器是别人起好的，我们只有连接。所以**没有 stdio**——那是
"起一个子进程"的传输，而这条路里宿主不起任何进程。

## 掉线就是掉线

连接只在加载那一刻建立。**不做自动重连**——那会立刻带来一串要定的事（多久试一次、
试几次放弃、退避怎么算），而恢复的手段本来就摆在那儿：改一下声明触发一次重加载。

`alive` 是**上一次请求的真实结论**，不是猜的。以前还能靠 `process.poll()` 判服务器
死了没有，现在服务器不归我们起，那一招没有了。

## 识别是它的事，宿主不参与

工具清单**是问出来的**（`tools/list`），不是谁声明的。所以"扫描期不知道有哪些工具"
不是缺陷，是分工：扫描期读的是**声明**（名字、审批、连哪儿），那些不用跑代码就能读到。

← 来自 mcp_runtime.py（MCPServerSpec / _StdioClient / MCPRuntime）
  —— 手写的 JSON-RPC + SSE 已删，换成库之上的薄适配层；stdio 那条路没有搬。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from anyio.from_thread import start_blocking_portal
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.exceptions import ToolError

#: 连不上的默认容忍时间（秒）。它是**主路径**，不是防御性写法。
DEFAULT_TIMEOUT = 10.0


class McpError(RuntimeError):
    """跟 MCP 服务器打交道的失败：连不上、答复畸形、调用报错。

    **它不区分"网络断了"和"服务器说不行"**——那是调用方要看的 `message`。
    这里只保证一件事：失败会被说出来，不会被吞成空结果。
    """


@dataclass(frozen=True)
class McpTool:
    """服务器告诉我们它有这么一个工具。**形状是从 `tools/list` 读出来的。**"""

    name: str
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)


def connect(url: str, *, timeout: float = DEFAULT_TIMEOUT) -> "McpConnection":
    """连上去并握手。**失败就抛**——调用方拿这个去记一条诊断。"""
    connection = McpConnection(url, timeout=timeout)
    connection.open()
    return connection


class McpConnection:
    """一条到外部 MCP 服务器的连接。**不是**进程管理器，也**不会**自己重连。"""

    def __init__(self, url: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        if not url:
            raise McpError("MCP 服务器必须给一个 url")
        self.url = url
        self.timeout = timeout
        # 事件循环那条后台线程归这个上下文管理器管——**必须留着它本身**：
        # 它一被回收，生成器就往里抛 GeneratorExit，循环当场停掉。
        self._loop = None
        self._portal = None
        self._client = None
        self._alive = False

    # ── 生命周期

    def open(self) -> None:
        """起一个后台事件循环，在它上面把连接立起来。"""
        loop = start_blocking_portal()
        portal = loop.__enter__()
        client = Client(StreamableHttpTransport(self.url), timeout=self.timeout)
        try:
            portal.call(client.__aenter__)
        except Exception as exc:
            loop.__exit__(None, None, None)
            raise McpError(f"连不上 MCP 服务器 {self.url}: {exc}") from exc
        self._loop, self._portal, self._client = loop, portal, client
        self._alive = True

    def close(self) -> None:
        """我们没有进程可收，只是把这条连接放掉。**可以重复调。**"""
        loop, portal, client = self._loop, self._portal, self._client
        self._loop, self._portal, self._client, self._alive = None, None, None, False
        if loop is None or portal is None or client is None:
            return
        try:
            portal.call(client.__aexit__, None, None, None)
        except Exception:                       # noqa: BLE001 — 收尾失败没有下一步可做
            pass
        loop.__exit__(None, None, None)

    @property
    def alive(self) -> bool:
        """**上一次请求的真实结论**，不是猜的。"""
        return self._alive

    # ── 识别与调用

    def list_tools(self) -> list[McpTool]:
        """问它有哪些工具。**这是唯一的事实来源**——清单上不写工具名。"""
        found = self._ask(lambda client: client.list_tools())
        return [
            McpTool(name=str(item.name),
                    description=str(getattr(item, "description", "") or ""),
                    input_schema=dict(getattr(item, "input_schema", None)
                                      or getattr(item, "inputSchema", None) or {}))
            for item in found or []
        ]

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """调一次。**服务器说工具报错就是报错**——不假装成功。"""
        result = self._ask(lambda client: client.call_tool(name, arguments or {}))
        return _plain(result)

    # ── 桥

    def _ask(self, action) -> Any:
        """在后台循环上跑一次请求，把失败翻译成 `McpError`。"""
        if self._portal is None or self._client is None:
            raise McpError(f"{self.url} 的连接已经关了")
        try:
            return self._portal.call(action, self._client)
        except ToolError as exc:
            raise McpError(str(exc)) from exc
        except McpError:
            raise
        except Exception as exc:
            self._alive = False
            raise McpError(f"跟 MCP 服务器 {self.url} 打交道失败: {exc}") from exc


def _plain(result: Any) -> Any:
    """把库的结果对象落成**能过 IPC 的纯数据**。

    结果要送回 worker 那个进程，所以这里是"翻译成 JSON 能装下的东西"，不是换个壳
    继续传对象。结构化结果优先——那是服务器明说"这是数据"的那一份。
    """
    data = getattr(result, "data", None)
    if data is None:
        data = getattr(result, "structured_content", None)
    if data is not None:
        return data
    blocks: list[Any] = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        blocks.append({"type": str(getattr(block, "type", "text")), "text": text}
                      if text is not None else {"type": str(getattr(block, "type", "text"))})
    return blocks
