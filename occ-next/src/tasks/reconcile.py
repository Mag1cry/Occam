"""重启对账：读启动记录、探 pid、把**说不了的**那几种收掉。

后端被杀时，非 daemon 的 worker 子进程会活下来；重启之后内存里的句柄全没了，只有
`launches.py` 里的 `process_id` 和 `started_at` 还留着。**重建这个判断是「不给同一个
Task 起第二个 worker」的前提。**

## 为什么是探测而不是杀掉

一个控制器**不能处置它从未持有的进程**，而且 pid 会被复用——按 pid 直接杀有可能杀掉一个
无关进程，那个动作**不可撤销**。所以这里只做两件事：**把还开着的启动记录挡在启动路径上**
（`controller.py` 的 `_refuse_if_orphaned`），以及**把三种确定的情况收成终态**。

**真正要不要处置由人决定。**

## 三种情况，只有一种要人

| 进程还在吗 | Task 什么状态 | 这里做什么 |
| --- | --- | --- |
| **在**（探测到的） | `running` | **什么都不做**——它可能还在写。挡住重启，等人 |
| 不在了 | `running` | 收成 `failed`：**它永远不会再说话了** |
| 没有启动记录 | `running` | 收成 `failed`：它没在跑，也不会有人再去跑它 |

第二行是"进程崩了但没报告"的下场，第三行是"建了 Task 却没起成"（比如宿主在那两步之间
被杀）。两者都**只有收成终态一条路**——留着一个永远 `running` 的 Task，界面上看不出它是
死了还是还在跑。

## 为什么单独立一个文件

它的读者和 `controller.py` 不是同一个人。那边答"一次 Task 怎么跑"，这边答"重启之后
哪些 Task 卡住了、为什么"。而它**读的是 `launches.py`，写的是内核的状态**——
和"守着一条管道"是两回事。

← 来自 control/task_controller.py::recover_after_restart + recovery_diagnostics
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..core.errors import CommandRejected, NotFound
from ..core.kernel import Kernel
from ..core.task import Fail
from .launches import LaunchLog
from .probe import is_alive


@dataclass(frozen=True)
class Reconciliation:
    """重启之后看出来的东西。**给人看的，不落库**（诊断不落库，ADR-028）。"""

    #: 还开着、而进程可能还在——**要人确认才能继续**。
    unresolved: tuple[str, ...] = ()
    #: 被这里收成 failed 的。
    settled: tuple[str, ...] = ()
    #: 一条一句人话，按 Task 排好。
    notes: tuple[str, ...] = ()
    #: 启动记录里出现过、但内核里已经没有的 Task。
    orphan_launches: tuple[str, ...] = field(default=())

    @property
    def clean(self) -> bool:
        return not self.unresolved and not self.settled and not self.orphan_launches


def reconcile(*, kernel: Kernel, launches: LaunchLog,
              probe=is_alive) -> Reconciliation:
    """跑一遍。**它是启动路径上的一次动作**，在任何人能点"启动"之前。"""
    unresolved: list[str] = []
    settled: list[str] = []
    notes: list[str] = []
    orphans: list[str] = []

    open_by_task = {launch.task_id: launch for launch in launches.open_launches()}
    for launch in open_by_task.values():
        task = _task_or_none(kernel, launch.task_id)
        if task is None:
            orphans.append(launch.task_id)
            notes.append(f"{launch.task_id}: 启动记录还在，Task 已经没了（pid {launch.process_id}）")
            launches.close(launch.launch_id, diagnostic="Task 已不存在")
            continue
        if task.is_terminal:
            # Task 已经收过了，只是那一条启动记录没关上——关掉它，不用惊动人。
            launches.close(launch.launch_id, diagnostic=f"Task 已是 {task.status}")
            continue
        if _alive(probe, launch):
            unresolved.append(launch.task_id)
            notes.append(
                f"{launch.task_id}: 上一次的进程（pid {launch.process_id}，{launch.started_at}）"
                f"可能还在跑——**先确认它，再决定要不要继续**")
            continue
        _settle(kernel, launches, launch, "上一次的进程已经没了，而且没有留下收尾报告",
                settled, notes)

    for task in kernel.list_tasks():
        if task.status != "running" or task.task_id in open_by_task:
            continue
        _settle(kernel, launches, None, "重启之后没有任何进程在跑它，也没有启动记录",
                settled, notes, task_id=task.task_id)

    return Reconciliation(unresolved=tuple(unresolved), settled=tuple(settled),
                          notes=tuple(notes), orphan_launches=tuple(orphans))


def _alive(probe, launch) -> bool:
    """**探测的结果只看这一个问题**：那个 pid 现在还是当初那个进程吗。"""
    try:
        return bool(probe(launch.process_id, launch.started_at))
    except Exception:                              # noqa: BLE001 — 探不动就按"可能活着"
        return True


def _settle(kernel: Kernel, launches: LaunchLog, launch, reason: str,
            settled: list[str], notes: list[str], task_id: str = "") -> None:
    identifier = task_id or (launch.task_id if launch else "")
    try:
        kernel.fail_task(Fail(task_id=identifier, reason=reason))
    except (CommandRejected, NotFound):
        pass                                       # 已经收过了——那正是我们要的结果
    else:
        settled.append(identifier)
    if launch is not None:
        launches.close(launch.launch_id, diagnostic=reason)
    notes.append(f"{identifier}: {reason}")


def _task_or_none(kernel: Kernel, task_id: str):
    try:
        return kernel.get_task(task_id)
    except NotFound:
        return None
