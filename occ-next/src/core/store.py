"""内核共用的那一个文件：事务、命令的形状、迁移通道。

里面三样东西只有一个共同点：**不属于任何一个原语，但每个原语都要用**。

| 装什么 | 为什么它不属于某个原语 |
| --- | --- |
| `Command` / `TaskCommand` / `CommandResult` | 命令是动作意图数据，**不是第五原语**（ADR-036） |
| `commit()` / `result_of()`（迁移通道） | 四个原语走**同一条**路，通道只有一条 |

（`CoreStore` / `CoreUnitOfWork` **不在这里**——它们说的是"接上存储"，那是绑定的活，
住在 `core/kernel.py`。放这里会和 `task.py` 撞成一个 import 环。）

除此之外没有别的东西住在这里——"共用"没有变成杂物抽屉。

## 迁移通道

```python
def commit(uow, command, task, *, event, decision="", data=None, error="") -> CommandResult:
    # 改状态 → 追加事件，一个事务里做完
```

**它是「唯一迁移通道」的落点**（ADR-019）。那条 ADR 要的是"每一次状态变化都有一条事件"——
以前靠一个中央类保证，现在靠**签名**：想改状态就必须同时给出要记的事件，
写不出"改了忘了记"的那种代码。

**调用方先改 `task` 上的字段，再调它。** 它负责把改动落下去：bump 版本、刷新时间、
存 Task、追加事件——**四件事绑在一起，缺一件都出不来**。

### 由此得到一条恒等式

> **`state_version` == 这条链上事件的条数。**

因为每一次 `commit` 恰好追加 **一条**事件、恰好 `+1`。这不是约定，是结构——
想破坏它就得绕开这个函数，而绕开这个函数就没有别的路能改状态。

（旧代码这条等式在**两处**不成立：直接放行的工具调用只追加事件、不 bump；
兑现拒绝只 bump、不追加。规则三当时只修了一处。）

## 这里没有命令幂等，挡重复提交的是状态机

| 命令 | 重复提交会怎样 |
| --- | --- |
| `Complete` | 只能从 `running` 出发 → 第二次是 `succeeded`，**拒** |
| `Fail` / `Cancel` | 只能从 `running` 或 `paused` 出发 → 第二次是终态，**拒** |
| `Resume` | 只能从 `paused` 出发 → 第二次是 `running`，**拒** |
| `Interrupt` | 只能从 `running` 出发 → 第二次是 `paused`，**拒** |
| `Approve` / `Deny` | **靠 `pending_decision` 那一格**：已经是目标值就是一次空转，**不记事件** |

**重放天然被拒，而且拒得看得见。** 这比缓存好：缓存是"悄悄把上一次的结果还给你"，
重放者不知道自己被挡了，**链上也不知道发生过什么**——而链正是我们唯一的说法。

### `CallFunction` 不在这张表里，取代缓存的是「请求指纹」

它不是控制状态的迁移，所以状态机管不着它。**认出"这不是新请求"的东西是指纹**
（`core/capability.py` 规则一/二）：

```text
指纹相同 + 已定案  → 兑现（allow / deny）      ← 这正是审批恢复时走的那条
指纹不同           → 新请求，重新判
```

**缓存不是"被绕过"，是被指纹取代了**——而且指纹比它硬：缓存比的是 worker 自己报上来的
一个不透明字符串，指纹比的是**这次请求的实际内容**（`tool_id` + `params_hash`）。
所以指纹要在**宿主这边**算，不能拿 worker 递过来的那个哈希当真。

### 唯一没有前置状态的是 `create_task`

它不迁移任何已有状态，所以重放会建出**第二个 Task**。这是唯一一处状态机挡不住的。
而且今天本来就是这样：不显式传幂等键就没有幂等（兜底是随机 uuid）。

**所以这条写进前端契约：改状态的命令不许自动重试。**
真要防，也只能用**调用方给的** id 去重——内核自己生成的 `command_id` / `request_id`
是每次尝试现生成的，拿它当幂等键等于没有幂等。

### 代价要认：重发就是重做

今天缓存会把重发的请求**原样答一遍**——不重判、不重执行。删掉之后，重发是一个**新请求**：
重新判，允许就**重新执行一次**。

所以"这次重试安不安全"必须由**工具自己声明**——`idempotency` 那一格。
它从此有了职责：**它是"重试安不安全"的声明**，不是命令缓存的替代品。

（worker 侧那条纪律写在 `tasks/channel.py`：别在超时之后盲目重试。）

## 命令的形状

```python
@dataclass(frozen=True)
class Command:                  # command_id / request_id —— 只为关联，不为去重
    ...

@dataclass(frozen=True)
class TaskCommand(Command):     # 加一个 task_id：一条发往**已有 Task** 的命令
    task_id: str = ""

@dataclass(frozen=True)
class CommandResult:            # task_id / decision / events / data / error
    ...
```

`TaskCommand` 被 Task 和 Capability 两边的命令共用（它们都发往一个已有 Task），
所以它不属于任何一个——这就是它在这里的原因。

**没有 `status`，也没有 `accepted`。** 拒绝是**异常**（`core/errors.py`），不是结果里的一个字段——
旧代码那一格恒为 `"accepted"`、`accepted` 属性恒为真，读它的人会以为自己判了错。

## 两个 Store 拼成事务对象

```text
core/task.py       TaskStore      get_task / list_tasks / save_task
core/event.py      EventStore     append_event / load_subject_chain
core/kernel.py     CoreUnitOfWork = 上面两个的并集
```

各自的声明在各自的原语文件里（"这个原语需要存什么"一眼可见）；
**并集住在 `kernel.py`**，因为"一次事务里能做什么"正是"接上存储"那句话的内容。

**没有第三个 Store。** 所以 `storage/schema.py` 里也只有两张表——
一张 Task 表、一张事件表，正好对应"内核只存两样东西"。

← 来自 core/ports.py + core/commands.py + core/service.py 的幂等与事件骨架
（`CommandStore` / `command_results` 表 / `idempotency_key` 三者已删）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from .event import ControlEvent, utc_now

if TYPE_CHECKING:  # 只为标注。运行时 import 它们会和 task.py 撞成一个环——
    # 这正是 `CoreUnitOfWork` 住在 kernel.py 的原因。
    from .kernel import CoreUnitOfWork
    from .task import Task


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex}"


@dataclass(frozen=True)
class Command:
    """一个动作的意图。`command_id` / `request_id` **只为关联**（日志、回给调用方），
    每次尝试现生成——所以它们挡不住重复提交，也不该被当成幂等键。"""

    command_id: str = field(default_factory=lambda: _id("cmd"))
    request_id: str = field(default_factory=lambda: _id("req"))


@dataclass(frozen=True)
class TaskCommand(Command):
    """一条发往**已有 Task** 的命令。Task 和 Capability 两边共用。"""

    task_id: str = ""


@dataclass(frozen=True)
class CommandResult:
    """一次命令做完了。**失败不在这里**——失败是异常。"""

    command_id: str
    request_id: str
    task_id: str = ""
    decision: str = ""
    events: tuple[str, ...] = ()
    data: dict[str, Any] = field(default_factory=dict)
    error: str = ""


def commit(uow: CoreUnitOfWork, command: Command, task: Task, *, event: ControlEvent,
           decision: str = "", data: dict[str, Any] | None = None,
           error: str = "") -> CommandResult:
    """**唯一迁移通道。** 把 task 此刻的样子写下去，同时追加这条事件。

    调用方在调它之前已经把字段改好了（`task.status = ...` / `task.pending_* = ...`）；
    它不解释那些改动，只负责**改动与事实一起落地**：

    1. `state_version += 1` —— 于是 `state_version` 恒等于链上的条数
    2. 刷新 `updated_at`
    3. 存 Task
    4. 追加事件

    **`event` 是必填的位置参数**，不是可选的。这就是 ADR-019 的落点：
    写不出"改了忘了记"的代码。
    """
    task.state_version += 1
    task.updated_at = utc_now()
    uow.save_task(task)
    uow.append_event(event)
    return CommandResult(
        command_id=command.command_id,
        request_id=command.request_id,
        task_id=task.task_id,
        decision=decision,
        events=(event.event_id,),
        data=data or {},
        error=error,
    )


def result_of(command: Command, *, task: Task | None = None, decision: str = "",
              data: dict[str, Any] | None = None, error: str = "") -> CommandResult:
    """**没有迁移**的结果：只回答，不落账。

    用它的地方必须能说清"为什么这次没有状态变化"——空转的审批是它唯一正当的用处。
    """
    return CommandResult(
        command_id=command.command_id,
        request_id=command.request_id,
        task_id=task.task_id if task else "",
        decision=decision,
        data=data or {},
        error=error,
    )


__all__ = [
    "Command", "TaskCommand", "CommandResult", "commit", "result_of",
    "ControlEvent", "utc_now",
]
