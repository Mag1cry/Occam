"""命令分派：**一张表**——命令名 → 处理函数。每条处理函数只做两三行。

```text
任务      create_task · start_task · approve · deny · resume · cancel    (6)
触发      schedule.trigger                                               (1)
开关      set_enabled                                                    (1)
声明      manifest.create / write / delete                               (3)
```

**"编辑"那四条（含 `set_enabled`）做的是同一件事**：改 `extensions/` 下某个声明文件的
一个字段，然后重读声明。三个容器走同一条路（`extensions/writer.py` 的 `Declarations`）。
命令名分着保留，是因为它是前端契约（`sendGatewayCommand('cancel', ...)`）——
**收实现，不收命令名**（ADR-025）。

**没有 `rescan`**：它当年存在的理由是"改 `.py` 源码之后热替换"，而那条路已经不要了
（`extensions/README.md` 的生命周期收敛）。改声明即时生效，改源码重启。

## 判决在这里做，边做边记账

每一次提交都记一条（谁、什么命令、什么结果、**谁脏了**）——那条 `subject_ref` 就是
事实流要说的话。失败也记：**"拒过什么"和"做过什么"一样是事实**。

错误**原样往上抛**（被拒、找不到、写不进去），因为"这算 4xx 还是 5xx"是接入面的事
（`web/http.py`）。门面只保证一件事：**记完账再抛**。

## 它不 import `tasks/`

起进程、终止进程是那边的事，而门面这里只需要两个动作：**建一个 Task、启动它**。
所以那两件事由 `TaskDispatch` 提供（它在这一层），`tasks/` 侧只收一个
`Dispatcher`（`tasks/scheduler.py`），两边都不 import 对方。

← 来自 gateway.py::submit
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from ..core.capability import Approve, Deny
from ..core.errors import CommandRejected, NotFound, OCCError
from ..core.kernel import Kernel
from ..core.task import Archive, Cancel, CreateTask, Forget
from ..extensions.writer import Declarations
from .audit import AuditLog
from .directory import Registry
from .permission.principal import Principal, system

#: 命令面。**就这些**——它就是前端的契约。
COMMANDS = (
    "create_task", "start_task", "approve", "deny", "resume", "cancel",
    "archive", "forget",
    "schedule.trigger", "schedule.delete",
    "set_enabled",
    "manifest.create", "manifest.write", "manifest.delete",
)

#: 声明那三条 + 开关那一条动的是哪个容器。
DECLARATION_TARGETS = ("package", "schedule", "provider")


class Runner(Protocol):
    """`tasks/controller.py` 的那只手。**起停进程不在这里。**"""

    def start(self, task_id: str, *, resume_value: Any = None) -> None: ...

    def cancel(self, task_id: str) -> None: ...


class Trigger(Protocol):
    """`tasks/scheduler.py` 的派发口。"""

    def trigger(self, name: str) -> str: ...

    def task_ids_of(self, name: str) -> list[str]:
        """这条日程派出去的那些 Core Task。

        **只有 scheduler 读得到**（派发记录归它），所以它从这里借出来——
        门面不自己去翻那张表：两处都能读的话，"一条日程拥有哪些 Task"就有了
        第二个答案，而它们迟早会对不上。
        """
        ...


class Refresher(Protocol):
    """重读声明的那一面（`extensions/hotload.py`）。"""

    def refresh(self) -> object: ...


@dataclass(frozen=True)
class Outcome:
    """一次提交做完了。`dirty` 是**谁脏了**——事实流靠它说话。"""

    data: dict[str, Any] = field(default_factory=dict)
    dirty: str = ""
    decision: str = ""


class TaskDispatch:
    """**建一个 Task，再启动它。** 派发和手动创建走的都是这两步。

    建之前在这里校验"这个执行者能不能跑"——**这是唯一拦得住它的地方**：加载期判不了
    "谁来用它"，而等到 worker 起不来才发现就已经晚了（`directory/executors.py`）。
    """

    def __init__(self, kernel: Kernel, runner: Runner, registry: Registry) -> None:
        self.kernel = kernel
        self.runner = runner
        self.registry = registry

    def create(self, *, summary: str, executor_ref: str, task_ref: str = "") -> str:
        executors = self.registry.executors
        if not executors.can_run(executor_ref):
            raise CommandRejected(executors.why_not(executor_ref))
        outcome = self.kernel.create_task(CreateTask(
            summary=summary, task_ref=task_ref, executor_ref=executor_ref))
        return outcome.task_id

    def start(self, task_id: str, *, resume_value: Any = None) -> None:
        """起来。**起不来不算命令失败**——Task 已经建好了，控制侧会把它收成 failed。"""
        self.runner.start(task_id, resume_value=resume_value)

    # ── 日程那侧看到的形状

    def create_and_start(self, *, summary: str, executor_ref: str, task_ref: str) -> str:
        task_id = self.create(summary=summary, executor_ref=executor_ref, task_ref=task_ref)
        self.start(task_id)
        return task_id


class Facade:
    def __init__(self, *, kernel: Kernel, registry: Registry, dispatch: TaskDispatch,
                 declarations: Declarations, runner: Runner, scheduler: Trigger,
                 refresher: Refresher, audit: AuditLog) -> None:
        self.kernel = kernel
        self.registry = registry
        self.dispatch = dispatch
        self.declarations = declarations
        self.runner = runner
        self.scheduler = scheduler
        self.refresher = refresher
        self.audit = audit
        self._handlers: dict[str, Callable[[dict], Outcome]] = {
            "create_task": self._create_task,
            "start_task": self._start_task,
            "approve": self._approve,
            "deny": self._deny,
            "resume": self._resume,
            "cancel": self._cancel,
            "archive": self._archive,
            "forget": self._forget,
            "schedule.trigger": self._trigger,
            "schedule.delete": self._delete_schedule,
            "set_enabled": self._set_enabled,
            "manifest.create": self._create_declaration,
            "manifest.write": self._write_declaration,
            "manifest.delete": self._delete_declaration,
        }

    # ── 唯一的入口

    def submit(self, command: str, payload: dict[str, Any] | None = None, *,
               principal: Principal | None = None) -> Outcome:
        handler = self._handlers.get(command)
        if handler is None:
            raise CommandRejected(f"没有这条命令: {command}")
        who = principal or system()
        body = dict(payload or {})
        try:
            outcome = handler(body)
        except Exception as exc:
            # 失败也记一笔：**"拒过什么"和"做过什么"一样是事实**。
            self.audit.record(command=command, principal=who.ref, outcome="error",
                              subject_ref=str(body.get("task_id") or body.get("name") or ""),
                              detail=str(exc))
            raise
        self.audit.record(command=command, principal=who.ref, outcome="ok",
                          subject_ref=outcome.dirty, detail=outcome.decision,
                          payload=outcome.data)
        return outcome

    # ── 任务

    def _create_task(self, body: dict) -> Outcome:
        task_id = self.dispatch.create(
            summary=str(body.get("summary") or ""),
            executor_ref=str(body.get("executor_ref") or ""),
            task_ref=str(body.get("task_ref") or ""))
        return Outcome(data={"task_id": task_id}, dirty=f"task:{task_id}")

    def _start_task(self, body: dict) -> Outcome:
        task_id = _need(body, "task_id")
        self.dispatch.start(task_id, resume_value=body.get("resume_value"))
        return Outcome(data={"task_id": task_id}, dirty=f"task:{task_id}")

    def _approve(self, body: dict) -> Outcome:
        return self._decide(body, approved=True)

    def _deny(self, body: dict) -> Outcome:
        return self._decide(body, approved=False)

    def _decide(self, body: dict, *, approved: bool) -> Outcome:
        """审批完**接着恢复执行**——那是控制侧的事，不是用户再点一次。

        恢复 = 从那个 checkpoint 重新起 worker；它会把同一个请求再发一遍，
        指纹对上了，内核就把这次调用兑现成 allow / deny（`function/pipeline.py`）。
        """
        task_id = _need(body, "task_id")
        decision_ref = str(body.get("decision_ref") or "")
        command = Approve(task_id=task_id, decision_ref=decision_ref) if approved else \
            Deny(task_id=task_id, decision_ref=decision_ref)
        outcome = self.kernel.approve(command) if approved else self.kernel.deny(command)
        return Outcome(data={"task_id": task_id, "auto_resume": self._recover(task_id)},
                       dirty=f"task:{task_id}", decision=outcome.decision)

    def _resume(self, body: dict) -> Outcome:
        task_id = _need(body, "task_id")
        return Outcome(data={"task_id": task_id, "auto_resume": self._recover(task_id)},
                       dirty=f"task:{task_id}")

    def _cancel(self, body: dict) -> Outcome:
        task_id = _need(body, "task_id")
        reason = str(body.get("reason") or "用户取消")
        # 先终止进程、再落状态：反过来的话，那个 worker 还在写，而 Task 已经是终态。
        self.runner.cancel(task_id)
        try:
            outcome = self.kernel.cancel_task(Cancel(task_id=task_id, reason=reason))
            decision = outcome.decision
        except CommandRejected:
            # **它在你按下去的前一刻自己收尾了。** 那是空转，不是错误——
            # 取消一个已经结束的东西，结果和你要的一样。
            decision = ""
        task = self.kernel.get_task(task_id)
        return Outcome(data={"task_id": task_id, "status": task.status},
                       dirty=f"task:{task_id}", decision=decision)

    def _archive(self, body: dict) -> Outcome:
        """收进档案馆。**只对跑完的 Task**，而且它不改状态——只多一行事实。"""
        task_id = _need(body, "task_id")
        self.kernel.archive_task(Archive(task_id=task_id))
        return Outcome(data={"task_id": task_id, "archived": True}, dirty=f"task:{task_id}")

    def _forget(self, body: dict) -> Outcome:
        """把这条历史从列表里拿掉。**先归档才删得掉**（那道门有用：删不可撤销）。

        删完之后它对执行者的引用就没了——那正是"这个包我不要了"那条路要走的
        最后一步（`_refuse_delete` 只数**还在的** Task）。
        """
        task_id = _need(body, "task_id")
        self.kernel.forget_task(Forget(task_id=task_id))
        return Outcome(data={"task_id": task_id, "forgotten": True}, dirty=f"task:{task_id}")

    def _recover(self, task_id: str) -> dict[str, Any]:
        """接着跑，**并把结果说出来**。

        审批写进了事件链（那是事实），而"接着跑"是另一件事，它会失败。
        两件事合成一句"成功"的话，用户会看着一个卡在 `paused` 的 Task 以为没事——
        所以答复里要带 `status`：

        | `status` | 意思是 |
        | --- | --- |
        | `resumed` | 起起来了 |
        | `skipped` | 它本来就不在等恢复的状态 |
        | `failed` | 想跑，没跑起来——`error` 是原因 |
        """
        task = self.kernel.get_task(task_id)
        if task.status != "paused":
            return {"status": "skipped", "reason": f"Task 不在等待恢复的状态（{task.status}）"}
        checkpoint = task.checkpoint_ref
        self.runner.start(task_id, resume_value=checkpoint)
        # **控制侧起不来不抛异常**（它把 Task 收成 failed，`tasks/controller.py`），
        # 所以结果要看落下来的状态，不看有没有异常。
        after = self.kernel.get_task(task_id)
        if after.status == "running":
            return {"status": "resumed", "checkpoint_ref": checkpoint}
        return {"status": "failed", "error": self._why_failed(task_id, after.status)}

    # ── 触发

    def _trigger(self, body: dict) -> Outcome:
        name = _need(body, "name")
        task_id = self.scheduler.trigger(name)
        return Outcome(data={"task_id": task_id}, dirty=f"task:{task_id}")

    # ── 删一条日程：**它拥有它的子 Task，所以删它得连它们一起处理**

    def _delete_schedule(self, body: dict) -> Outcome:
        """删掉一条日程，**先清它派出去的那些子 Task，再删那份声明**。

        ## 为什么不能只删文件

        子 Task 在**外层看不见**（归编排台管，`world-model.md`：子 Task 不进入外层），
        而编排台是按**日程名**开出来的。声明一删，编排台就没有了，那些 Task 于是
        变成**没人认领**的：外层不画、馆里不装、编排台进不去——只能躺在库里。
        所以顺序反过来是错的：先删声明就再也说不出这些 Task 归谁。

        ## 它们走的是**和别人一样的两道门**

        `archive` → `forget`（`core/task.py`）：内核那条"删之前先归档"的规矩不为
        这条命令破例。还在跑的（`running` / `paused`）**先取消**——不取消的话
        归档这一步就会被拒，而"日程都删了、它还在跑"本来也不是用户要的。
        取消的理由写进事件链（`CANCELLED: 日程 X 被删除`），删掉的是 Task 那一行，
        **事件一条都不动**。

        ## 失败在哪儿停下

        任务这一圈先跑完，声明才删。中途出错就地抛出去（`CommandRejected` 原样
        往上走），**那份声明还在**——用户看得见原因，收拾完再来一次即可；
        已经删掉的那些下一轮会跳过（查不到就当它已经处理过了）。
        """
        name = _need(body, "name")
        forgotten = self._forget_children(name)
        self.declarations.delete("schedule", name)
        self.refresher.refresh()
        return Outcome(data={"name": name, "tasks_forgotten": forgotten},
                       dirty=f"schedule:{name}")

    def _forget_children(self, name: str) -> list[str]:
        gone: list[str] = []
        for task_id in self.scheduler.task_ids_of(name):
            try:
                task = self.kernel.get_task(task_id)
            except NotFound:
                continue                     # 上一轮已经删掉了：接着处理剩下的
            if not task.is_terminal:
                self.kernel.cancel_task(Cancel(task_id=task_id,
                                               reason=f"日程 {name} 被删除"))
            if not task.archived:
                self.kernel.archive_task(Archive(task_id=task_id))
            self.kernel.forget_task(Forget(task_id=task_id))
            gone.append(task_id)
        return gone

    # ── 开关与声明：四条命令，一条实现

    def _set_enabled(self, body: dict) -> Outcome:
        target = str(body.get("target") or "package")
        name = _need(body, "name")
        self._reload(lambda: self.declarations.set_enabled(target, name, bool(body.get("enabled"))))
        return Outcome(data={"target": target, "name": name}, dirty=f"{target}:{name}")

    def _create_declaration(self, body: dict) -> Outcome:
        target = _need(body, "target")
        name = _need(body, "name")
        self._reload(lambda: self.declarations.create(target, name, dict(body.get("data") or {})))
        return Outcome(data={"target": target, "name": name}, dirty=f"{target}:{name}")

    def _write_declaration(self, body: dict) -> Outcome:
        target = _need(body, "target")
        name = _need(body, "name")
        field_name = _need(body, "field")
        self._reload(lambda: self.declarations.set_field(target, name, field_name,
                                                         body.get("value")))
        return Outcome(data={"target": target, "name": name, "field": field_name},
                       dirty=f"{target}:{name}")

    def _delete_declaration(self, body: dict) -> Outcome:
        target = _need(body, "target")
        name = _need(body, "name")
        if target == "package":
            self._refuse_delete(name)
        if target == "schedule":
            # **删日程不从这里走**：它有自己的子 Task 要处理（见 `_delete_schedule`）。
            # 放行的话，那些 Task 会变成没人认领的——外层不画、馆里不装、
            # 编排台也随着声明一起没了。
            raise CommandRejected(
                "删日程走 schedule.delete——它要先把它派出去的那些 Task 处理掉")
        self.declarations.delete(target, name)
        self.refresher.refresh()
        return Outcome(data={"target": target, "name": name}, dirty=f"{target}:{name}")

    def _refuse_delete(self, package_id: str) -> None:
        """**删之前先看有没有历史引用。** 删包 = 删目录，不可撤销（ADR-033）。

        没有这条保护，"创建了又不要了"就只能靠禁用，而 `extensions/` 会越积越多
        说不清来路的包；有了它，删除是安全的默认动作，代价是偶尔要连带处理几个 Task。
        """
        provided = {item.name for item in self.registry.executors.all()
                    if item.package == package_id}
        if not provided:
            return
        referenced = sorted(task.task_id for task in self.kernel.list_tasks()
                            if task.executor_ref in provided)
        if referenced:
            raise CommandRejected(
                f"{package_id} 还被 {len(referenced)} 个 Task 引用着，不能删："
                f"{' · '.join(referenced[:5])}")

    def _reload(self, write: Callable[[], None]) -> None:
        """**先写、再重读。** 写失败就别重读——磁盘上什么都没变。"""
        write()
        self.refresher.refresh()


def _why_failed(kernel: Kernel, task_id: str, status: str) -> str:
    events = [item for item in kernel.events(task_id) if item.event_type == "FAILED"]
    if events:
        return str(events[-1].payload.get("reason") or "")
    return f"Task 现在是 {status}"


def _need(body: dict, key: str) -> str:
    value = str(body.get(key) or "")
    if not value:
        raise CommandRejected(f"这条命令缺少 {key}")
    return value


__all__ = ["Facade", "Outcome", "TaskDispatch", "COMMANDS", "CommandRejected",
           "NotFound", "OCCError"]
