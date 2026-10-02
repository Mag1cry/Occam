"""Event Chain 原语：控制事件是什么、怎么存回来。

## 它不产生事件

产生事件的是各个原语——谁改状态，谁负责记那一笔：

| 事件 | 谁产生 |
| --- | --- |
| `TASK_CREATED` / `COMPLETED` / `FAILED` / `CANCELLED` | `core/task.py` |
| `FUNCTION_APPROVAL_REQUESTED` / `APPROVED` / `DENIED` / `FUNCTION_CALLED` / `INTERRUPTED` / `RESUMED` | `core/capability.py` |

**就这 10 种，没有别的。** `SUBJECT_ONLINE` / `SUBJECT_OFFLINE` / `SUBJECT_ERROR` 已删
（`core/executor.py` 里写了为什么：那是**观测**，而链是不可删的）。

本文件定的是**那个封闭的集合**（`EVENT_TYPES`）和事件本身的形状——
外部不能提交任意控制事件，类型只能从这里出。

## 它提供**模具**，不做零件

```python
def new_event(event_type, subject_ref, *, task_id="", tool_id="", external_ref="", payload=None):
    ...
```

造一条事件要填七个参数，其中有三个约定：`event_id` 的格式、`subject_ref` 的拼法
（`task:` 前缀）、`external_ref` 的回落（默认沿用 Task 上的引用）。**10 种事件类型各写各的，
这些约定就会抄错，而抄错不会报错，只会在链上长出一条格式不一样的事件。**

分工是清楚的：**这里回答"一条合法的事件长什么样"，各原语回答"什么时候要有、是哪种、
payload 装什么"。** 所以这跟"不产生事件"不冲突——**它做模具，不做零件**。

## 时间也在这里定：`utc_now()`

格式是 **UTC 的 ISO-8601 带偏移**（`2026-09-28T10:00:00+00:00`）。

它住在这里有两个理由：**① 链上的顺序靠它比较**（全表读回来是按追加序，但人看的是时间）；
**② 它是"一条事件长什么样"的一部分**，跟 `event_id` 的格式、`subject_ref` 的拼法同一类东西。
Task 的 `created_at` / `updated_at` 也用它——**同一种时间只有一种写法**。

**它不是单调序号。** 同一事务里造的两条事件时间可以并列，时钟回拨也会乱序。
链的**顺序**由追加序（存储层的 rowid）保证，时间只是一个可读的标注。

## 存储

```python
class EventStore(Protocol):
    def append_event(self, event: ControlEvent) -> StoredEvent: ...
    def load_subject_chain(self, subject_ref: str) -> list[StoredEvent]: ...
```

**只有追加和按 subject 读**，没有更新、没有删除——事件是不可变事实。
链的完整性（checksum + prev_hash）是**实现**的事（`storage/control.py`），不是这个 Port 的事：
Port 只声明"能追加、能读回"。

## 每条链独立

**今天只有一种 subject：Task**（`task:<id>`）。执行者和设备都不再往链上写——
执行者是**按需起的子进程**（跑完就结束，没有"在线"这回事），设备是扩展包
（"活着"就是连得上，那是客户端的观测）。

`subject_ref` 仍然是不透明字符串，**但别为一个已经不存在的对象重新发明 subject。**
给谁开一条链，等于声明"它的状态变化是我们必须记住的事实"——开之前先回答这个。

← 来自 core/models.py 的 ControlEvent / EVENT_TYPES / StoredEvent + core/ports.py 的 EventStore
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Protocol
from uuid import uuid4

if TYPE_CHECKING:  # 只为标注——`CoreStore` 的家在 kernel.py（并集住在那里）
    from .kernel import CoreStore

#: 封闭集合。**加一种要在这里加**，别在别处拼字符串——拼错了运行期才知道。
EVENT_TYPES = frozenset({
    "TASK_CREATED",
    "FUNCTION_APPROVAL_REQUESTED",
    "INTERRUPTED",
    "APPROVED",
    "DENIED",
    "RESUMED",
    "FUNCTION_CALLED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    #: 收进档案馆。**只有跑完的 Task 能归档**——还在动的东西不是历史。
    "TASK_ARCHIVED",
})


def utc_now() -> str:
    """现在几点，按链上唯一的那个写法。"""
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ControlEvent:
    """一条控制事实。**造它用 `new_event`**，别直接构造。"""

    event_id: str
    event_type: str
    subject_ref: str
    task_id: str = ""
    tool_id: str = ""
    external_ref: str = ""
    occurred_at: str = field(default_factory=utc_now)
    payload: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.event_type not in EVENT_TYPES:
            raise ValueError(f"非法控制事件: {self.event_type}")
        if not self.event_id or not self.subject_ref:
            raise ValueError("事件 ID 和 subject_ref 不能为空")


@dataclass(frozen=True)
class StoredEvent:
    """事件 + 它在链上的 checksum。checksum 由存储层算，内核不碰。"""

    event: ControlEvent
    checksum: str


class EventStore(Protocol):
    """内核需要存储提供的：能追加、能按 subject 读回。**没有更新、没有删除。**"""

    def append_event(self, event: ControlEvent) -> StoredEvent: ...

    def load_subject_chain(self, subject_ref: str) -> list[StoredEvent]: ...


def subject_of(task_id: str) -> str:
    """`task:<id>`。拼法只有这一处，别在调用点手写前缀。"""
    return f"task:{task_id}"


def chain_of(store: CoreStore, subject_ref: str) -> list[ControlEvent]:
    """按 subject 读回一条链。

    **这不是链校验**——返回的是子集，第一条的 `prev_hash` 指的是另一条链上的行。
    校验只在 `storage/control.py` 里对全表做。
    """
    with store.read_transaction() as uow:
        return [item.event for item in uow.load_subject_chain(subject_ref)]


def new_event(event_type: str, subject_ref: str, *, task_id: str = "",
              tool_id: str = "", external_ref: str = "", payload: dict[str, Any] | None = None) -> ControlEvent:
    """模具：把三个约定一次做对。

    1. `event_id` 的形状（`evt-<uuid4>`）
    2. `subject_ref` 是**调用方给的**——它知道自己在给谁记账
    3. 时间取 `utc_now()`

    `external_ref` 的"默认沿用 Task 上的引用"**不在这里做**：模具看不见 Task。
    调用方自己传空串就是空串——回落是原语的判断，不是格式的判断。
    """
    return ControlEvent(
        event_id=f"evt-{uuid4().hex}",
        event_type=event_type,
        subject_ref=subject_ref,
        task_id=task_id,
        tool_id=tool_id,
        external_ref=external_ref,
        payload=payload or {},
    )
