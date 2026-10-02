"""工具句柄的契约。**这里是它唯一该在的地方。**

```python
@dataclass(frozen=True)
class ToolSpec:                      # ← 数据，可序列化，跨得进子进程
    name: str                        # 全名：供给名 + 函数名
    description: str = ""
    input_schema: dict = ...

class ToolChannel(Protocol):         # ← 调用方要实现的形状
    def call(self, tool: str, params: dict) -> CallResult: ...
```

## 为什么在调用方而不在实现方

句柄从 gateway 出去，"调一次 = 判一次"才是**结构上**成立的，不靠纪律。
这和执行者的 `adapter` 正好相反：那个契约跟着**实现方**走（包作者照着写），
这个跟着**调用方**走（gateway 要保证判决）。

**而真正的墙是进程边界**：worker 在另一个进程里，我们给它什么它才有什么。所以传给它的
是 `ToolSpec` 的清单（名字 + schema），worker 侧照着立起 stub。宿主内部这几个列表
藏不藏**不是安全**，是设计纪律（`directory/README.md`）。

## 三个读者，每一格都刚好够用

| 谁 | 用它的哪部分 |
| --- | --- |
| worker 的能力框架 | 三格全用——原样绑给模型（`tasks/channel.py` 契约四） |
| 前端 | `name` + `description` |
| 内核的记账 | `name` |

## 没有凭证参数

以前 `invoke(grant, params)` 要收一张内核签发的 `AuthorizationGrant`——判决搬进网关
之后那张凭证就是签给自己，成了自证。现在靠**结构**：调用的唯一出口是 `pipeline.py`，
它是四步一体的。

← 来自 capabilities/protocol.py（AuthorizationGrant 已删）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from ..permission.decision import ALLOW, DENY, NEEDS_APPROVAL


@dataclass(frozen=True)
class ToolSpec:
    """一个工具在**调用方**眼里的样子。"""

    name: str
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CallResult:
    """一次工具调用回给 worker 的东西。**判定在里面，因为三种答案都要说清。**

    | `decision` | 意思是 |
    | --- | --- |
    | `allow` | 跑完了（`ok` 说跑成没跑成） |
    | `needs_approval` | 停在这里等人批，`reason_ref` 是那个理由 |
    | `deny` | 不许，`error` 是为什么 |
    """

    decision: str
    tool_id: str = ""
    ok: bool = False
    result: Any = None
    error: str = ""
    reason_ref: str = ""


def allowed(tool_id: str, result: Any) -> CallResult:
    return CallResult(ALLOW, tool_id=tool_id, ok=True, result=result)


def failed(tool_id: str, error: str) -> CallResult:
    """允许了、去跑了、**它自己失败了**——判定仍然是 `allow`。"""
    return CallResult(ALLOW, tool_id=tool_id, ok=False, error=error)


def needs_approval(tool_id: str, reason_ref: str) -> CallResult:
    return CallResult(NEEDS_APPROVAL, tool_id=tool_id, reason_ref=reason_ref)


def denied(tool_id: str, error: str) -> CallResult:
    return CallResult(DENY, tool_id=tool_id, error=error)


class ToolChannel(Protocol):
    """**工具在这条线上长什么样。** host 侧由 `pipeline.py` 实现，worker 侧是 stub。"""

    def call(self, tool: str, params: dict[str, Any]) -> CallResult: ...
