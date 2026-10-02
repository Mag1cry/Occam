"""找到这个工具的**供给**，把调用递过去。

供给有两种，这一层的活是同一个：**按全名找到它，调它。**

| 供给 | 递过去的方式 |
| --- | --- |
| 包内单例 | 直接调那个方法——一次普通函数调用 |
| 外部 MCP 服务器 | 交给 `extensions/mcp_client.py` 走一次 HTTP |

**两种供给在这里汇成一个形状**：再往上（`pipeline.py` 的判定、内核的记账）看不出区别。
这是"统一"该发生的地方——不是统一供给，是统一**调用形状**。

它是四步里的第 ④ 步：判定过、定性过、内核记过账之后，才走到这里。

## 工具抛异常在这一层不吞

包里那个单例住在宿主进程里，它抛什么就冒什么——**翻译成 worker 看得懂的答复**是
`pipeline.py` 的事（那里才知道该回什么形状）。这一层只负责"找不到就说找不到"。

## 换一批供给 = 换一张索引

`replace()` 重建索引时**不关闭旧的**：收尾归 `extensions/hotload.py`——它才知道
"新的一份已经交出去了"，那才是可以收旧的时刻。

← 来自 gateway.py::invoke 的后半
"""
from __future__ import annotations

from typing import Any, Callable

from ...extensions.tools import Supply


class ToolMissing(LookupError):
    """这个名字现在没有实现。**可能是刚被关掉的那个工具**——重判一次就是拒绝。"""


class ToolSupplies:
    def __init__(self) -> None:
        self._index: dict[str, Callable[[dict[str, Any]], Any]] = {}
        self._supplies: tuple[Supply, ...] = ()

    def replace(self, supplies: tuple[Supply, ...]) -> None:
        self._supplies = tuple(supplies)
        self._index = {item.tool_id: item.invoke
                       for supply in self._supplies for item in supply.tools}

    def supplies(self) -> tuple[Supply, ...]:
        return self._supplies

    def has(self, tool_id: str) -> bool:
        return tool_id in self._index

    def invoke(self, tool_id: str, params: dict[str, Any]) -> Any:
        invoke = self._index.get(tool_id)
        if invoke is None:
            raise ToolMissing(f"没有这个工具的实现: {tool_id}")
        return invoke(params or {})
