"""Task 原语：委托、控制状态、外部引用。

这个文件是**自洽的**：Task 是什么、它需要被怎么读写、有哪几条命令作用于它、
它们怎么迁移、产生哪几条事件——全在这里，不用跳到别处拼。

## 存储

```python
class TaskStore(Protocol):
    def get_task(self, task_id: str) -> Task | None: ...
    def list_tasks(self) -> list[Task]: ...
    def save_task(self, task: Task) -> None: ...
```

## 四条命令与它们的迁移

| 命令 | 从 | 到 | 事件 |
| --- | --- | --- | --- |
| `CreateTask` | — | `running` | `TASK_CREATED` |
| `Complete` | `running` | `succeeded` | `COMPLETED` |
| `Fail` | `running` / `paused` | `failed` | `FAILED` |
| `Cancel` | `running` / `paused` | `cancelled` | `CANCELLED` |

（`paused` / `running` 的往返**也在这里**——见下。）

## 全部迁移都在这个文件里

| 迁移 | 谁驱动 | 事件由谁给 |
| --- | --- | --- |
| → `running`（创建） | 用户 / 日程 | `task.py` |
| → `succeeded` / `failed` / `cancelled` | 执行者 | `task.py` |
| `running` → `paused` | **审批链**（`capability.py` 调用 `pause()`） | `capability.py` |
| `paused` → `running` | **审批链**（`capability.py` 调用 `resume()`） | `capability.py` |

**状态机必须在一个文件里读完**——只写在 `capability.py` 里那两条，读 `task.py` 的人会以为
Task 只会走向终态。所以 `pause()` / `resume()` 这两个迁移函数住在**这里**，
`capability.py` 调用它们、并负责给出事件（发起的那一方才说得出"为什么"）。

## 时间戳

`created_at` / `updated_at` 直接写在 dataclass 的默认值里，没有单独的时钟模块——
一个只有一行的间接层不值得一个文件。写法由 `core/event.py` 的 `utc_now()` 定，
**同一种时间只有一种写法**。

## Task 上寄放着 Capability 的几格

`pending_tool_id` / `pending_reason_ref` / `pending_decision`，**外加一格请求指纹**。

这不是巧合——待审批本来就长在委托上（"这件事卡在等人批"），所以 Capability 不需要自己的表。

`pending_fingerprint` 记"那次审批针对的**哪个请求**"（`tool_id` + `params_hash`）。
没有它，"兑现"就只按工具名比——批准了 A 却可以执行 B（见 `capability.py` 的规则一）。

## 它是数据，不是实体

Task 是纯数据；迁移是**这个文件里的函数**，不是 Task 的方法——父类化的钩子会把它的
可序列化性和可测性一起赔进去。

## 字段只留有人读的

旧 Task 有 14 格，新的是 14 - 4 + 1。删掉的四格各有理由：

| 删掉 | 为什么 |
| --- | --- |
| `external_runtime_ref` | **零读者**。全仓只有 `Complete` 写它，没有任何地方读 |
| `attempt` | **永远是 1**。没有任何命令会加它 |
| `idempotency_key` | 命令缓存整个删了（`core/store.py`） |
| `request_id` | 内核**每次尝试现生成**的关联 id，存在 Task 上没有意义——它是**那次调用**的东西，不是这个委托的东西 |

加回来的一格是 `pending_fingerprint`（见上）。

`executor_config_ref` 改名 **`executor_ref`**：名字里那半截"配置"的来源
（供应商作用域）已经没了，条目名换成全名（`extensions/README.md`）。

← 来自 core/models.py 的 Task / TASK_STATUSES + core/ports.py 的 TaskStore
  + core/commands.py 的四条命令 + core/service.py 的对应迁移
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, ClassVar, Protocol
from uuid import uuid4

from .errors import CommandRejected, Conflict, NotFound
from .event import ControlEvent, new_event, subject_of, utc_now
from .store import CommandResult, TaskCommand, commit, result_of

if TYPE_CHECKING:  # 只为标注——`CoreStore` 的家在 kernel.py（并集住在那里）
    from .kernel import CoreStore

#: Task 的控制状态。**五个，就这五个**——`completed` / `interrupted` / `failed`
#: 是**执行者说的话**，落到这里分别是 `succeeded` / `paused` / `failed`
#: （两套词的对应表在 `tasks/channel.py`）。
TASK_STATUSES = frozenset({"running", "paused", "succeeded", "failed", "cancelled"})


@dataclass
class Task:
    """一次委托。**纯数据**——迁移在下面的函数里，不是它的方法。"""

    task_id: str
    summary: str
    task_ref: str
    status: str
    executor_ref: str
    session_ref: str = ""
    checkpoint_ref: str = ""
    state_version: int = 0
    pending_tool_id: str = ""
    pending_reason_ref: str = ""
    pending_decision: str = ""
    pending_fingerprint: str = ""
    #: 收进档案馆了吗。**它不是第六个状态**：归档说的是"这条历史我不管了"，
    #: 与"它跑成什么样"无关——所以它是 Task 上的一个事实，不是状态机上的一格。
    archived: bool = False
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)

    VALID_STATUSES: ClassVar[frozenset[str]] = TASK_STATUSES

    def __post_init__(self) -> None:
        if self.status not in self.VALID_STATUSES:
            raise ValueError(f"非法任务状态: {self.status}")
        # sqlite 没有布尔：读回来的是 0/1。**在这里收口**——不然 `is False`
        # 会在真库上是假的、在内存里是真的，而那是最难查的一种不一致。
        self.archived = bool(self.archived)

    @property
    def is_terminal(self) -> bool:
        return self.status in {"succeeded", "failed", "cancelled"}

    @property
    def has_pending(self) -> bool:
        return bool(self.pending_tool_id)

    def clear_pending(self) -> None:
        """把待审批那几格清空。**调用方负责记事件**（`commit` 要求同时给）。"""
        self.pending_tool_id = self.pending_reason_ref = ""
        self.pending_decision = self.pending_fingerprint = ""


class TaskStore(Protocol):
    def get_task(self, task_id: str) -> Task | None: ...

    def list_tasks(self) -> list[Task]: ...

    def save_task(self, task: Task) -> None: ...

    def delete_task(self, task_id: str) -> None: ...


@dataclass(frozen=True)
class CreateTask(TaskCommand):
    summary: str = ""
    task_ref: str = ""
    executor_ref: str = ""


@dataclass(frozen=True)
class Complete(TaskCommand):
    result_ref: str = ""


@dataclass(frozen=True)
class Fail(TaskCommand):
    reason: str = ""


@dataclass(frozen=True)
class Cancel(TaskCommand):
    reason: str = ""


def new_task_id() -> str:
    """`task-<uuid4>`。**不扫全表查重**——旧代码那样做是为了防碰撞，
    但 uuid4 的碰撞概率比磁盘坏掉还低，那次全表扫描纯属浪费。"""
    return f"task-{uuid4().hex}"


def require_task(uow: TaskStore, task_id: str) -> Task:
    task = uow.get_task(task_id)
    if task is None:
        raise NotFound(f"Task 不存在: {task_id}")
    return task


def create(store: CoreStore, command: CreateTask) -> CommandResult:
    """建一个 Task，**落地就是 `running`**。

    前置检查只有形状：`summary` 和 `executor_ref` 非空。
    **"这个执行者存在吗"不在这里判**——内核不知道有哪些执行者
    （`core/README.md`），那是网关提交命令之前的事。

    `session_ref` 在这里生成：它是**这个 Task 独有的一条线程**
    （执行者拿它做 checkpoint 的命名空间），所以它是委托的一部分，不是调用方给的。

    **没有正文就是空串**，不拿 `request_id` 顶替：那是一个**关联 id**，不是文件引用，
    顶上去等于凭空指了一个不存在的文件——而"读不到正文就别起进程"那条（`tasks/inputs.py`）
    会因此把一个根本没有正文的委托判成失败。
    """
    if not command.summary or not command.executor_ref:
        raise CommandRejected("summary 和 executor_ref 不能为空")
    with store.transaction() as uow:
        task = Task(
            task_id=new_task_id(),
            summary=command.summary,
            task_ref=command.task_ref,
            status="running",
            executor_ref=command.executor_ref,
            session_ref=str(uuid4()),
        )
        event = new_event("TASK_CREATED", subject_of(task.task_id), task_id=task.task_id,
                          payload={"summary": task.summary})
        return commit(uow, command, task, event=event)


def complete(store: CoreStore, command: Complete) -> CommandResult:
    if not command.result_ref:
        raise CommandRejected("complete 必须提供 result_ref")
    return _finish(store, command, "succeeded", "COMPLETED", command.result_ref)


def fail(store: CoreStore, command: Fail) -> CommandResult:
    if not command.reason:
        raise CommandRejected("fail 必须提供 reason")
    return _finish(store, command, "failed", "FAILED", command.reason)


def cancel(store: CoreStore, command: Cancel) -> CommandResult:
    if not command.reason:
        raise CommandRejected("cancel 必须提供 reason")
    return _finish(store, command, "cancelled", "CANCELLED", command.reason)


@dataclass(frozen=True)
class Archive(TaskCommand):
    """收进档案馆：**它跑完了，我不再管它了。**

    只有终态的 Task 能归档——一个还在跑的东西不是"历史"，把它收起来等于把
    "它还在动"这件事藏掉。
    """


@dataclass(frozen=True)
class Forget(TaskCommand):
    """把这条历史从列表里拿掉。**只有归档过的才能删。**

    归档是那道确认门：先收进档案馆看一眼，再决定要不要永久拿掉。没有它，
    "删"就会混进日常操作里，而它**不可撤销**。

    **事件链一条都不动。** 删的是 Task 那一行，而事件是"这里发生过什么"的
    记忆——删掉它们会当场扯断 `prev_hash` 那条链（`storage/control.py` 是
    哈希链），而且"抹掉证据"和"不再管它"本来就是两件事。
    """


def archive(store: CoreStore, command: Archive) -> CommandResult:
    with store.transaction() as uow:
        task = require_task(uow, command.task_id)
        if not task.is_terminal:
            raise CommandRejected(
                f"Task 状态 {task.status} 不能归档——只有跑完的（succeeded / failed / "
                f"cancelled）才是历史")
        if task.archived:
            raise Conflict(f"{task.task_id} 已经归档过了")
        task.archived = True
        event = new_event("TASK_ARCHIVED", subject_of(task.task_id), task_id=task.task_id)
        return commit(uow, command, task, event=event)


def forget(store: CoreStore, command: Forget) -> CommandResult:
    with store.transaction() as uow:
        task = require_task(uow, command.task_id)
        if not task.archived:
            raise CommandRejected(
                f"{task.task_id} 还没归档——先归档再删。那道门是有用的：删不可撤销")
        uow.delete_task(task.task_id)
        # **没有事件可记**：它是被删掉的那一个。谁删的记在网关流水里
        # （`gateway/facade.py` 每条命令都记一笔），那才是"发生过什么"的地方。
        return result_of(command, task=task)


def _finish(store: CoreStore, command: TaskCommand, status: str, event_type: str,
            detail: str) -> CommandResult:
    with store.transaction() as uow:
        task = require_task(uow, command.task_id)
        allowed = {"running"} if status == "succeeded" else {"running", "paused"}
        if task.status not in allowed:
            raise CommandRejected(f"Task 状态 {task.status} 不能执行 {event_type}")
        task.status = status
        # 结果本身**不进内核**（ADR-008 有意不存返回值），链上只留一个引用。
        event = new_event(event_type, subject_of(task.task_id), task_id=task.task_id,
                          payload={"result_ref": detail} if event_type == "COMPLETED" else {"reason": detail})
        return commit(uow, command, task, event=event)


def get(store: CoreStore, task_id: str) -> Task:
    with store.read_transaction() as uow:
        return require_task(uow, task_id)


def list_all(store: CoreStore) -> list[Task]:
    with store.read_transaction() as uow:
        return uow.list_tasks()


def pause(uow: TaskStore, command: TaskCommand, task: Task, *,
          event: ControlEvent) -> CommandResult:
    """`running` → `paused`。**审批链调用它**（`capability.py` 的 `Interrupt`）。

    收的是**已经读出来的那个 Task**，不是 task_id——调用方刚刚在它身上设了
    `checkpoint_ref`（停在哪），重新加载会把那一格丢掉。

    事件由**发起方**给：只有它说得出"停在哪、为什么停"。
    """
    task.status = "paused"
    return commit(uow, command, task, event=event)


def resume(uow: TaskStore, command: TaskCommand, task: Task, *,
           event: ControlEvent) -> CommandResult:
    """`paused` → `running`。同样由审批链调用，同样收那个 Task。"""
    task.status = "running"
    return commit(uow, command, task, event=event)
