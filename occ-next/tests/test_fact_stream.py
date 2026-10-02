"""**事实落链之后叫一声**——那只耳朵（`on_fact`）。

事实流读的是 `gateway_events` 那张表，而**只有 `facade.submit` 往里写**——于是它今天
只看得见**命令面**：worker 那条路（请求审批、跑完、失败）走的是
`tasks/controller.py` → `pipeline.py` → `core/kernel.py`，**根本不经过门面**。

后果是界面上的：**"有人要审批"这件事要等下一次重读才出现**，而它自称"实时"。

补法是把耳朵插在**事实唯一的落点**上（`storage/control.py` 的 `transaction()`），
提交成功之后叫一声。这两条钉的就是那个位置的两条规矩：

- **提交成功才叫**：回滚掉的事实谁也不该听见；
- **worker 那条路也叫**：它们不经过门面，但一样是内核确认过的事实。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.core.event import new_event, subject_of
from src.storage.control import SqliteCoreStore
from tests.support.newtree import application, wait_for_status


def test_提交成功之后才叫(tmp_path: Path):
    heard: list = []
    store = SqliteCoreStore(tmp_path / "control.sqlite", on_fact=heard.append)
    try:
        with store.transaction() as uow:
            uow.append_event(new_event("TASK_CREATED", subject_of("task-x"), task_id="task-x"))

        assert [fact.event_type for fact in heard] == ["TASK_CREATED"]
    finally:
        store.close()


def test_回滚了就不叫(tmp_path: Path):
    """**没落库的事实谁也不该听见。** 在事务里叫一声，就等于让界面去读一件
    根本不存在的事——而它已经被人看过了。"""
    heard: list = []
    store = SqliteCoreStore(tmp_path / "control.sqlite", on_fact=heard.append)
    try:
        with pytest.raises(RuntimeError):
            with store.transaction() as uow:
                uow.append_event(new_event("TASK_CREATED", subject_of("task-x"),
                                           task_id="task-x"))
                raise RuntimeError("半路炸了")

        assert heard == []
    finally:
        store.close()


def test_worker_那条路的事实也进流水(tmp_path: Path):
    """`guard.run` 一上手就要调一个**要审批**的工具，于是它停下来。

    走到 `paused` 为止**没有任何人提交过命令**（只有最开始那条 `start_task`）——
    所以流水里那两条 `kernel` 的行只可能来自耳朵：

    ```text
    FUNCTION_APPROVAL_REQUESTED   内核记下"有人要批"
    INTERRUPTED                   Task 停下来等
    ```

    这正是"推送"要用的那两条：前端浮窗、飞书卡片都得靠它们。
    """
    application_ = application(tmp_path, approve=False)
    try:
        task_id = application_.facade.submit("create_task", {
            "summary": "守卫", "executor_ref": "guard.run",
            "task_ref": "hello.txt"}).data["task_id"]
        application_.facade.submit("start_task", {"task_id": task_id})
        wait_for_status(application_.kernel, task_id, "paused")

        rows = application_.audit.after(0)
        kernel_rows = [row for row in rows if row.principal == "kernel"]

        # `TASK_CREATED` 也在里面：耳朵听的是**所有**事实，不只是没人替我记的那些
        assert [row.command for row in kernel_rows] == [
            "TASK_CREATED", "FUNCTION_APPROVAL_REQUESTED", "INTERRUPTED"]
        # 而且它们**说得清是谁脏了**——事实流靠这一格说话（ADR-031）
        assert {row.subject_ref for row in kernel_rows} == {f"task:{task_id}"}
    finally:
        application_.shutdown()
