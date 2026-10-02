"""内核的绑定：把存储接上，把命令露出来。

```python
kernel = Kernel(store)          # 装配期决定一次，之后没人再碰 store
kernel.create_task(command)
kernel.call_function(command)
kernel.get_task(task_id)
```

## 为什么需要它

因为**事务边界要有主**，而存储不该出现在外围的签名里。

- 不绑定 → 每个调用点都得先拿到 store 再传进去（gateway、tasks、web 全都要）
- 绑定之后 → **存储只出现在两个地方**：装配（决定用哪个）和内核（用它）

## 它的章程：只转发，不许有别的

| 可以 | 不可以 |
| --- | --- |
| 持有 store | **不许有 `if`** |
| 一行转发到原语的命令函数 | 不许构造事件 |
| | 不许读 Task |
| | 不许校验、不许判决 |

**出现任何一样，就说明逻辑长进绑定里了**——那就是 `CoreControlPlane` 回魂，
而它被拆掉正是因为它把规则、存储、事件构造全装在了一个类里。

这条可以测：`Kernel` 的每个方法体只有一行。**它是个把手，不是个大脑。**

## 谁开事务

**命令函数自己开**，不是 Kernel。因为"读还是写"是那条命令自己知道的事——
`get_task` 走读事务，`create_task` 走写事务，Kernel 不该替它判断。

（**迁移函数不开事务**——它们在事务里面被调用，见 `core/task.py` 的 `pause()` / `resume()`。
"命令"开事务、"迁移"用事务，这条分工在文件签名上看得见：命令收 `store`，迁移收 `uow`。）

## 两个 Store 在这里合并

```python
class CoreUnitOfWork(TaskStore, EventStore, Protocol): ...
class CoreStore(Protocol):
    def transaction(self) -> AbstractContextManager[CoreUnitOfWork]: ...
    def read_transaction(self) -> AbstractContextManager[CoreUnitOfWork]: ...
```

**为什么并集住在这里**：这两份声明的家各在 `task.py` 和 `event.py`，但把它们拼起来这件事
是"接上存储"——那正是绑定在说的话。放在 `store.py` 会撞成一个 import 环
（`task.py` 要从 `store.py` 拿命令的形状）。

**没有第三个 Store。** 内核只存两样东西。

## store 从哪来

装配期决定，来自配置：`Settings.database_path` ← 环境变量 `OCC_NEXT_DB`
（默认 `data/occ-next-v1-control.sqlite`）。`storage/control.py` 是实现。

← 新增：它是 core/service.py 被拆掉之后，"内核作为一个整体"需要一个能被指向的东西
"""
from __future__ import annotations

from contextlib import AbstractContextManager
from typing import Protocol

from . import capability, task as tasks
from .event import ControlEvent, EventStore, chain_of
from .task import Task, TaskStore

__all__ = ["Kernel", "CoreStore", "CoreUnitOfWork"]


class CoreUnitOfWork(TaskStore, EventStore, Protocol):
    """一次事务里能做的事 = `TaskStore` **+** `EventStore`，一字不多。"""


class CoreStore(Protocol):
    """决定用哪个实现的是装配（`app/build.py`），用它的是内核。
    中间任何一层都看不见它。"""

    def transaction(self) -> AbstractContextManager[CoreUnitOfWork]: ...

    def read_transaction(self) -> AbstractContextManager[CoreUnitOfWork]: ...


class Kernel:
    """把手，不是大脑。**每个方法体只有一行。**"""

    def __init__(self, store: CoreStore) -> None:
        self.store = store

    # ── Task 的四条命令
    def create_task(self, command: tasks.CreateTask) -> object:
        return tasks.create(self.store, command)

    def complete_task(self, command: tasks.Complete) -> object:
        return tasks.complete(self.store, command)

    def fail_task(self, command: tasks.Fail) -> object:
        return tasks.fail(self.store, command)

    def cancel_task(self, command: tasks.Cancel) -> object:
        return tasks.cancel(self.store, command)

    def archive_task(self, command: tasks.Archive) -> object:
        return tasks.archive(self.store, command)

    def forget_task(self, command: tasks.Forget) -> object:
        return tasks.forget(self.store, command)

    # ── Capability 的五条命令
    def call_function(self, command: capability.CallFunction) -> object:
        return capability.call_function(self.store, command)

    def approve(self, command: capability.Approve) -> object:
        return capability.approve(self.store, command)

    def deny(self, command: capability.Deny) -> object:
        return capability.deny(self.store, command)

    def interrupt(self, command: capability.Interrupt) -> object:
        return capability.interrupt(self.store, command)

    def resume(self, command: capability.Resume) -> object:
        return capability.resume(self.store, command)

    # ── 读
    def get_task(self, task_id: str) -> Task:
        return tasks.get(self.store, task_id)

    def list_tasks(self) -> list[Task]:
        return tasks.list_all(self.store)

    def events(self, task_id: str) -> list[ControlEvent]:
        return chain_of(self.store, f"task:{task_id}")
