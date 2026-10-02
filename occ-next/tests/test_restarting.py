"""重启之后：**哪些 Task 卡住了、为什么**。

后端被杀时，非 daemon 的 worker 子进程会活下来；重启之后内存里的句柄全没了，只有启动
记录里的 `process_id` 和 `started_at` 还留着。重建这个判断是**「不给同一个 Task 起第二个
worker」**的前提——两个进程同时写同一个 checkpoint 是数据损坏，不是小毛病。

三件事分开钉：

- **探测**：那个 pid 现在还是当初那个进程吗（pid 会被复用）
- **对账**：还在跑的不动、跑没了的收终态、压根没起的也收终态
- **挡住重启**：还开着的那一条，挡住第二次启动
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from src.core.errors import CommandRejected
from src.core.event import utc_now
from src.core.task import Complete, CreateTask
from src.tasks.probe import is_alive
from tests.support.newtree import application


# ── 探测：光看"这个 pid 存在吗"是不够的

def test_活着的进程_出生时间对得上():
    assert is_alive(os.getpid(), utc_now()) is True


def test_pid_存在但出生时间对不上_判死():
    """**pid 会被复用。** 一个不相干的进程完全可能顶上这个号——
    问一句"你是什么时候出生的"，才不会把别人当成自己人。
    """
    assert is_alive(os.getpid(), "2000-01-01T00:00:00+00:00") is False


def test_拿不到出生时间_保守判活():
    """**误报的方向要选安全的**：判活最坏是要人确认一次；判死的代价是起第二个写者。"""
    assert is_alive(os.getpid(), "") is True
    assert is_alive(os.getpid(), "不是时间") is True


def test_没有这个_pid_就是死():
    assert is_alive(0, utc_now()) is False
    assert is_alive(-1, utc_now()) is False


# ── 对账的三种落点

def _park(app, *, process_id: int, started_at: str = "", task_id: str = "") -> str:
    """造一个"上次没收拾干净"的现场：一个跑着的 Task + 一条还开着的启动记录。

    `started_at` 是**改出来的**：真实那条记录写的是"现在"（`launches.open` 不让人指定
    时间），而这里要造的是"上次那个进程"——所以直接把那一格改成想要的。
    """
    if not task_id:
        created = app.kernel.create_task(CreateTask(summary="上次的", executor_ref="echo.run",
                                                    task_ref="hello.txt"))
        task_id = created.task_id
    launch = app.launches.open(task_id=task_id, executor_ref="echo.run", process_id=process_id)
    if started_at:
        _rewrite_started_at(app, launch.launch_id, started_at)
    return task_id


def _rewrite_started_at(app, launch_id: str, started_at: str) -> None:
    import sqlite3

    connection = sqlite3.connect(app.settings.launches)
    connection.execute("UPDATE worker_launches SET started_at = ? WHERE launch_id = ?",
                       (started_at, launch_id))
    connection.commit()
    connection.close()


def test_进程还在_不动它_但要人看一眼(tmp_path: Path):
    """**一个控制器不能处置它从未持有的进程。** 它可能还在写。"""
    from src.tasks.reconcile import reconcile

    app = application(tmp_path)
    try:
        task_id = _park(app, process_id=os.getpid(), started_at=utc_now())

        report = reconcile(kernel=app.kernel, launches=app.launches)

        assert report.unresolved == (task_id,)
        assert report.settled == ()
        assert app.kernel.get_task(task_id).status == "running", "它还在跑，不该被收掉"
    finally:
        app.shutdown()


def test_进程没了_收成终态(tmp_path: Path):
    """它永远不会再说话了——留着一个永远 running 的 Task，界面上看不出它死了。"""
    from src.tasks.reconcile import reconcile

    app = application(tmp_path)
    try:
        task_id = _park(app, process_id=os.getpid(),
                        started_at="2000-01-01T00:00:00+00:00")

        report = reconcile(kernel=app.kernel, launches=app.launches)

        assert report.settled == (task_id,)
        assert app.kernel.get_task(task_id).status == "failed"
        assert app.launches.open_launches() == [], "启动记录也要收掉"
    finally:
        app.shutdown()


def test_压根没起过_也收成终态(tmp_path: Path):
    """建了 Task 却没起成（宿主在那两步之间被杀）——它没在跑，也不会有人再去跑它。"""
    from src.tasks.reconcile import reconcile

    app = application(tmp_path)
    try:
        created = app.kernel.create_task(CreateTask(summary="没起过", executor_ref="echo.run"))

        report = reconcile(kernel=app.kernel, launches=app.launches)

        assert created.task_id in report.settled
        assert app.kernel.get_task(created.task_id).status == "failed"
    finally:
        app.shutdown()


def test_已经收过尾的_不惊动人(tmp_path: Path):
    from src.tasks.reconcile import reconcile

    app = application(tmp_path)
    try:
        created = app.kernel.create_task(CreateTask(summary="跑完了", executor_ref="echo.run"))
        app.kernel.complete_task(Complete(task_id=created.task_id, result_ref="好了"))
        _park(app, process_id=os.getpid(), started_at=utc_now(), task_id=created.task_id)

        report = reconcile(kernel=app.kernel, launches=app.launches)

        assert report.clean is True, "Task 已经收了，只是启动记录没关上——关掉就行"
        assert app.launches.open_launches() == []
    finally:
        app.shutdown()


# ── 挡住重启

def test_上一次还没收尾_不许起第二次(tmp_path: Path):
    """**这是这条判断存在的全部理由。** 两个进程写同一个 checkpoint = 数据损坏。"""
    app = application(tmp_path)
    try:
        task_id = _park(app, process_id=os.getpid(), started_at=utc_now())

        with pytest.raises(CommandRejected) as caught:
            app.facade.submit("start_task", {"task_id": task_id})

        assert "对账" in str(caught.value)
        assert app.controller.running_ids() == ()
    finally:
        app.shutdown()
