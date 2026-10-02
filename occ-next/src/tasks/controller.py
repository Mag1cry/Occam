"""持有 Worker 句柄、听 IPC、提交内核命令。

**它是 Task 运行期的那只手**：起一次运行、守着它的管道、把 worker 说的话翻译成内核命令。

## 它不判决

Worker 说"我要调这个工具"，它做的事只有一件：**把请求交给
`gateway/function/pipeline.py`，把答复原样发回去。**

那二十行当年住在这里（`control/task_controller.py::_handle_tool`），所以这一层曾经知道
"判定有哪几种"、要 import 内核的 `CallFunction`。**搬走之后它不知道了**——
判决只做一遍，而它连第二遍在哪都不知道。

## 它不处置它没持有的进程

重启之后内存里的句柄全没了。看见历史记录里的 pid，**只探测、不杀**——pid 会被复用，
杀错不可撤销。那部分活归 `reconcile.py`。

## 终态的映射在这里，而且只有一张表

Worker 只说"我是怎么结束的"，**那意味着什么终态是这一层的事**：

| Worker 说 | 这里提交 |
| --- | --- |
| `COMPLETED` | `Complete`——结果取**最后一次的输出** |
| `INTERRUPTED` | `Interrupt` + checkpoint 引用 |
| `FAILED` | `Fail` |
| **什么都没说，进程就没了** | `Fail`——**这才是"其他任何异常"的落点** |

最后一行是这张表存在的理由：**静默退出也要有终态**。不然一个崩掉的 Worker 会留下一个
永远 `running` 的 Task，而界面上看不出它是死了还是还在跑。

## 同一条命令提交第二次会被拒——那就读成"已经收过尾了"

内核挡重复提交靠状态机（`core/store.py`），所以几条 best-effort 的收尾路径（启动失败补
`Fail`、进程没了补 `Fail`）会撞上 `CommandRejected`。**那不是新错误**，是"这件事已经做过了"。

## 一条命令一件锁

每个 Task 一把锁。同一时刻只允许一件事在推它——IPC 监听线程和界面命令是两个调用者，
没有锁就会有两个写者。

← 来自 control/task_controller.py（工具管线搬走、重启对账拆出）
"""
from __future__ import annotations

import threading
from typing import Any

from ..core.capability import Interrupt, Resume
from ..core.errors import CommandRejected, NotFound
from ..core.kernel import Kernel
from ..core.task import Complete, Fail
from ..gateway.directory import Registry
from ..gateway.function.pipeline import ToolPipeline, ToolRequest
from . import inputs
from .channel import COMPLETED, FAILED, INTERRUPTED, TOOL_REQUEST, Channel, reply_to
from .launches import LaunchLog
from .spawn import LaunchPlan, WorkerProcess, WorkerSpawner

#: 监听线程一问一答的节奏（秒）。**它同时也是"发现进程死了"的节奏**——
#: 所以它必须存在：没有它，一个崩掉的 worker 要等到下一次有人说话才被发现。


class TaskController:
    def __init__(self, *, kernel: Kernel, registry: Registry, pipeline: ToolPipeline,
                 spawner: WorkerSpawner, launches: LaunchLog, workspace: Any,
                 database_path: Any) -> None:
        self.kernel = kernel
        self.registry = registry
        self.pipeline = pipeline
        self.spawner = spawner
        self.launches = launches
        self.workspace = workspace
        self.database_path = str(database_path)
        self._handles: dict[str, WorkerProcess] = {}
        self._launches: dict[str, str] = {}
        self._locks: dict[str, threading.RLock] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._guard = threading.RLock()
        #: **宿主手里那份工具返回值**：按 Task 存最近一次**成功**调用的结果。
        #:
        #: 工具的返回值和执行者报上来的 `result_ref` 不是一回事：`weather.collect`
        #: 拿到一整个 dict，而 worker 只把它压成"杭州 阴 21.8°"一句话。那份细的
        #: 一直在宿主手里（`pipeline.py` 调用、`_answer_tool` 转给 worker），
        #: 以前**转完就丢**。留在这里，没有 adapter 的执行者才有东西可读。
        #:
        #: **它活不过重启**——这是宿主的运行时记忆，不是台账。所以只留最近
        #: `RESULT_MEMORY` 条：长跑的主机不能靠一个 dict 无限攒住每一条工具结果。
        self._tool_results: dict[str, Any] = {}

    #: 宿主记住多少条工具返回值。超了就丢最旧的那条（dict 的插入序就是到达序）。
    RESULT_MEMORY = 256

    def last_tool_result(self, task_id: str) -> Any:
        """这个 Task 最近一次**成功**的工具调用返回值；没有就是 `None`。

        它是 `read_task` 在没有 adapter 时的**首选**回落——比链上那条 `result_ref`
        细得多（那条是执行者自己压缩过的一句话）。
        """
        with self._guard:
            return self._tool_results.get(task_id)

    # ── 起

    def start(self, task_id: str, *, resume_value: Any = None) -> None:
        """起一次运行。**幂等是"已经有了就不重复起"**，不是"起两次差不多"。"""
        with self._lock_for(task_id):
            task = self.kernel.get_task(task_id)
            if task.is_terminal:
                raise CommandRejected(f"Task 已经是终态: {task.status}")
            if task_id in self._handles:
                return
            self._refuse_if_orphaned(task_id)

            if task.status == "paused":
                # 从 checkpoint 继续。**内核先走一步**：两者必须完全相等
                # （`core/capability.py` 的 `Resume`），对不上就不该起。
                checkpoint = str(resume_value or task.checkpoint_ref)
                outcome = self.kernel.resume(Resume(task_id=task_id, checkpoint_ref=checkpoint))
                task = self.kernel.get_task(task_id)
                resume_value = checkpoint if outcome.decision != "deny" else None

            try:
                text = inputs.read(task.task_ref, root=self.workspace)
            except inputs.InputMissing as exc:
                # **正文读不到就别起进程**——起来了也是跑到一半炸，而那时 Task 已经
                # 看着像跑过了（`inputs.py` 的说明）。
                self._finish(task_id, Fail(task_id=task_id, reason=str(exc)))
                return
            self._spawn(task, text, resume_value)

    def _spawn(self, task: Any, text: str, resume_value: Any) -> None:
        definition = self.registry.executors.get(task.executor_ref)
        if definition is None or definition.worker is None:
            self._finish(task_id=task.task_id,
                         command=Fail(task_id=task.task_id,
                                      reason=f"没有可以跑的执行者: {task.executor_ref}"))
            return
        worker = definition.worker
        plan = LaunchPlan(
            descriptor={"root": worker.root, "entrypoint": worker.entrypoint,
                        "package": worker.package},
            task_data={
                "task_id": task.task_id, "summary": task.summary, "task_ref": task.task_ref,
                "executor_ref": task.executor_ref, "session_ref": task.session_ref,
                "state_version": task.state_version,
                "supply_name": definition.package,
            },
            config_data=self.registry.executor_config(definition),
            input_text=text,
            database_path=self.database_path,
            resume_value=resume_value,
        )
        try:
            process = self.spawner.start(plan)
        except Exception as exc:                   # noqa: BLE001 — 起不来也要有终态
            self._finish(task.task_id, Fail(task_id=task.task_id,
                                            reason=f"Worker 起不来: {type(exc).__name__}: {exc}"))
            return
        launch = self.launches.open(task_id=task.task_id, executor_ref=task.executor_ref,
                                    process_id=process.process_id)
        with self._guard:
            self._handles[task.task_id] = process
            self._launches[task.task_id] = launch.launch_id
        thread = threading.Thread(target=self._listen, args=(task.task_id, process, launch.launch_id),
                                  name=f"occ-listener-{task.task_id}", daemon=True)
        with self._guard:
            self._threads[task.task_id] = thread
        thread.start()

    def _refuse_if_orphaned(self, task_id: str) -> None:
        """上一次启动还开着、而那个进程**可能还活着**——不许起第二个写者。

        它是不是真活着由 `reconcile.py` 判，这里只认"那一条还没收"。**误报的方向是安全的**：
        最坏情况是要人确认一次，而不是两个进程同时写同一个 checkpoint。
        """
        open_launch = self.launches.open_for(task_id)
        if open_launch is not None:
            raise CommandRejected(
                f"Task {task_id} 上一次启动（pid {open_launch.process_id}）还没收尾，"
                f"先对账再起")

    # ── 听

    def _listen(self, task_id: str, worker: WorkerProcess, launch_id: str) -> None:
        channel = Channel(worker.connection, task_id)
        try:
            while True:
                message = channel.receive(0.5)
                if message is not None:
                    if self._handle(task_id, message):
                        return
                    continue
                if worker.alive or channel.pending():
                    continue
                if not self._owns(task_id):
                    # 有人把它收掉了（取消终止了这个进程）——**那不是我该收的尾**。
                    return
                # **什么都没说，进程就没了。** 这是"其他任何异常"真正的落点。
                self._finish(task_id, Fail(task_id=task_id,
                                           reason=self._silent_reason(worker)))
                return
        finally:
            self._forget(task_id)

    def _handle(self, task_id: str, message: Any) -> bool:
        """处理一条消息。**返回 True 表示这个 Task 已经收尾了。**"""
        if message.kind == TOOL_REQUEST:
            self._answer_tool(task_id, message)
            return False
        if message.kind == COMPLETED:
            self._finish(task_id, Complete(
                task_id=task_id,
                result_ref=str(message.payload.get("result_ref")
                               or message.payload.get("checkpoint_ref") or "")),
                report_kind=COMPLETED)
            return True
        if message.kind == INTERRUPTED:
            return self._interrupt(task_id, message)
        if message.kind == FAILED:
            self._finish(task_id, Fail(task_id=task_id,
                                       reason=str(message.payload.get("reason") or "执行者报错")),
                         report_kind=FAILED)
            return True
        if message.kind not in ("", None):
            self._finish(task_id, Fail(task_id=task_id,
                                       reason=f"看不懂的收尾消息: {message.kind}"),
                         report_kind=FAILED)
            return True
        return False

    def _interrupt(self, task_id: str, message: Any) -> bool:
        """**停下来等审批。** 必须有一个待审批对得上——它刚才要的就是那次调用。"""
        task = self.kernel.get_task(task_id)
        try:
            self.kernel.interrupt(Interrupt(
                task_id=task_id,
                tool_id=task.pending_tool_id,
                checkpoint_ref=str(message.payload.get("checkpoint_ref") or ""),
                reason_ref=task.pending_reason_ref))
        except CommandRejected:
            # 没有待审批却停了下来：它不是在等人批，是**没理由地停了**——收成 failed。
            self._finish(task_id, Fail(task_id=task_id,
                                       reason="执行者停下来等审批，但没有对应的待审批"),
                         report_kind=FAILED)
        else:
            self._close_launch(task_id, report_kind=INTERRUPTED)
        return True

    def _answer_tool(self, task_id: str, message: Any) -> None:
        """**只转发，不判决。** 判定在 `gateway/function/pipeline.py`，只做一遍。"""
        with self._guard:
            worker = self._handles.get(task_id)
        if worker is None:
            return
        task = self.kernel.get_task(task_id)
        result = self.pipeline.call(ToolRequest(
            task_id=task_id,
            executor_ref=task.executor_ref,
            tool_id=str(message.payload.get("tool_id") or ""),
            params=dict(message.payload.get("params") or {}),
            # **原先这里还补一个 `target_ref=task.task_ref`**（"这次调用冲着谁去"）。
            # 它已删：那个值同一个 Task 里永远不变，在指纹里区分不了任何两次调用，
            # 而 `task_ref` 允许为空——一旦为空，内核的前置检查会把**每一次**
            # 工具调用都拒掉（`core/capability.py` 的模块说明记了这件事）。
            request_id=message.request_id,
        ))
        # **留下那份返回值。** 这里是唯一一次拿到**原始**返回的地方——worker 收到
        # 之后只会把它压成一句话报上来（`weather` 那三个字段），细的那份就没了。
        # 没有 adapter 的执行者，读结果只能靠这一份（`read_task` 的回落）。
        if result.ok:
            with self._guard:
                self._tool_results[task_id] = result.result
                while len(self._tool_results) > self.RESULT_MEMORY:
                    self._tool_results.pop(next(iter(self._tool_results)), None)

        try:
            worker.connection.send(reply_to(result, message.request_id))
        except OSError:
            pass                                    # 对面没了：监听线程下一圈就会发现

    def _finish(self, task_id: str, command: Any, report_kind: str = "") -> None:
        """提交收尾命令，**容忍"已经收过了"**。"""
        try:
            if isinstance(command, Complete):
                self.kernel.complete_task(command)
            elif isinstance(command, Fail):
                self.kernel.fail_task(command)
            else:
                self.kernel.cancel_task(command)
        except (CommandRejected, NotFound):
            pass                                    # 已经有终态了——那正是我们想达到的
        self._close_launch(task_id, report_kind=report_kind)

    def _close_launch(self, task_id: str, *, report_kind: str = "") -> None:
        launch_id = self._launches.get(task_id)
        if launch_id:
            self.launches.close(launch_id, report_kind=report_kind)

    def _silent_reason(self, worker: WorkerProcess) -> str:
        """静默退出的理由——**能说什么就说什么**。退出码是这里唯一的信息来源。"""
        code = worker.process.exitcode
        return f"执行者没有报告就结束了（退出码 {code}）"

    def _owns(self, task_id: str) -> bool:
        with self._guard:
            return task_id in self._handles

    def _forget(self, task_id: str) -> None:
        """**必须收掉句柄**：留着它，"这个 Task 正在跑"就是一句假话。

        锁也一起收——**但要先确认没人拿着它**：拿不下的说明有人在里面做事，
        那时候把它从表里摘掉，等于让下一个调用者拿到另一把锁，两个人就同时进来了。
        """
        with self._guard:
            worker = self._handles.pop(task_id, None)
            self._launches.pop(task_id, None)
            self._threads.pop(task_id, None)
            lock = self._locks.get(task_id)
            if lock is not None and lock.acquire(blocking=False):
                try:
                    self._locks.pop(task_id, None)
                finally:
                    lock.release()
        if worker is not None:
            worker.close()

    # ── 停

    def cancel(self, task_id: str) -> None:
        """终止那个进程。**没杀干净要留痕**——那正是重启之后探测得到的那一类。"""
        with self._lock_for(task_id):
            with self._guard:
                worker = self._handles.get(task_id)
            if worker is None:
                return
            died = worker.terminate()
            self.launches.close(self._launches.get(task_id, ""), report_kind="",
                                diagnostic="" if died else "终止后进程仍在")
            if not died:
                # 句柄留着：它还在跑，而这个事实必须在内存里也成立。
                return
            self._forget(task_id)

    def stop_all(self) -> list[str]:
        """关停时的清单。**返回没杀干净的那些**——它们要被记下来，不能静默丢掉。"""
        with self._guard:
            task_ids = list(self._handles)
        survivors: list[str] = []
        for task_id in task_ids:
            self.cancel(task_id)
            with self._guard:
                if task_id in self._handles:
                    survivors.append(task_id)
        return survivors

    def running_ids(self) -> tuple[str, ...]:
        with self._guard:
            return tuple(sorted(self._handles))

    def open_workers(self) -> list[dict[str, Any]]:
        """**现在谁在跑。** 一行一次启动，`alive` 是**现场探的**（防 pid 复用）。

        它是 `tasks/` 对外的说法——探 pid 这件事在这一层，别处不自己探。
        `unreconciled` 是"进程还在、而宿主手里没有它"：**要人对账的那一种**。
        """
        from .probe import is_alive

        held = set(self.running_ids())
        found = []
        for launch in self.launches.open_launches():
            alive = is_alive(launch.process_id, launch.started_at)
            found.append({"task_id": launch.task_id, "process_id": launch.process_id,
                          "started_at": launch.started_at, "alive": alive,
                          "unreconciled": alive and launch.task_id not in held})
        return found

    def _lock_for(self, task_id: str) -> threading.RLock:
        with self._guard:
            lock = self._locks.get(task_id)
            if lock is None:
                lock = self._locks[task_id] = threading.RLock()
            return lock
