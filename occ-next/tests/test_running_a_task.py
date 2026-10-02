"""跑一次委托：从建 Task 到收尾，穿过全部四层。

它测的是**系统能做什么**，不是"哪个模块对不对"：建一个 Task → 起一个真进程 →
它经 IPC 要一次工具 → 判决 → 执行 → 报收尾 → Task 落地。

中间那几条边界是这里的重点：

- **工具调用绕不过判决**：worker 只能"说"，拿到的答复是判完的那一种
- **停下来等审批是停真的一步**：Task 到 `paused`，批准之后**从同一个请求继续**
- **静默退出也要有终态**：崩掉的 worker 不会留下一个永远 `running` 的 Task
- **关停要真的把人叫停**：不是一个标记
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.core.errors import CommandRejected
from tests.support import newtree
from tests.support.newtree import (
    BOOM_WORKER, PLAIN_WORKER, SILENT_WORKER, application, wait_for_status, wait_until,
    write_package,
)


@pytest.fixture
def app(tmp_path: Path):
    application_ = application(tmp_path)
    yield application_
    application_.shutdown()


def _run(app, **payload):
    """建一个 Task 并启动它。返回 task_id。"""
    created = app.facade.submit("create_task", {"summary": "跑一次", **payload})
    task_id = created.data["task_id"]
    app.facade.submit("start_task", {"task_id": task_id})
    return task_id


# ── 跑到底

def test_一次委托跑到成功(app):
    task_id = _run(app, executor_ref="echo.run", task_ref="hello.txt")

    task = wait_for_status(app.kernel, task_id, "succeeded")

    assert task.status == "succeeded"
    events = [item.event_type for item in app.kernel.events(task_id)]
    assert events[0] == "TASK_CREATED"
    assert events[-1] == "COMPLETED"
    assert "FUNCTION_CALLED" in events, "工具调用要留下一条控制事实"


def test_事件条数等于_state_version(app):
    """**内核那条恒等式**：每一次迁移恰好一条事件，于是版本号就是链上的条数。"""
    task_id = _run(app, executor_ref="echo.run", task_ref="hello.txt")
    task = wait_for_status(app.kernel, task_id, "succeeded")

    assert task.state_version == len(app.kernel.events(task_id))


def test_结果不在内核里_执行者说它存哪了(app):
    """内核只留一个引用（ADR-008），结果本身归执行者的包。"""
    task_id = _run(app, executor_ref="echo.run", task_ref="hello.txt")
    task = wait_for_status(app.kernel, task_id, "succeeded")

    completed = [item for item in app.kernel.events(task_id) if item.event_type == "COMPLETED"][0]
    assert completed.payload["result_ref"]
    assert "text" not in completed.payload, "返回值不该进事件链"


# ── 判决挡在中间

def test_执行者没被允许用那个工具_worker_拿到的是拒绝(app, tmp_path: Path):
    """**默认拒绝**：`tools_from` 没写它，就是不许。

    worker 拿到的是 `tool_denied`——它没有别的路，只能问这一条管道。
    """
    newtree.write_package(app.settings.extensions, "boom", """\
id: boom
tools:
  - name: boom
    approval_required: false
    entrypoint: provider.py:Echo
executors:
  - name: boom.run
    tools_from: [别的供给]
    worker: {entrypoint: "worker.py:run"}
""", {"provider.py": newtree.ECHO_PROVIDER, "worker.py": PLAIN_WORKER})
    app.hotloader.refresh()

    task_id = _run(app, executor_ref="boom.run", task_ref="hello.txt")
    task = wait_for_status(app.kernel, task_id, "failed")

    assert "没有被允许使用" in _last_reason(app, task_id, "FAILED")
    assert task.status == "failed"


def test_工具自己炸了_是执行者失败不是判决拒绝(app, tmp_path: Path):
    """**"允许了、去跑了、它自己失败了"**——判定仍然是 allow，落点是 failed。"""
    newtree.write_package(app.settings.extensions, "crasher", """\
id: crasher
tools:
  - name: echo
    approval_required: false
    entrypoint: provider.py:Echo
executors:
  - name: crasher.run
    tools_from: [echo]
    worker: {entrypoint: "worker.py:run"}
""", {"provider.py": newtree.ECHO_PROVIDER, "worker.py": """\
from src.tasks.channel import COMPLETED, FAILED, WorkerChannel


def run(connection, task_data, config_data, input_text, database_path, resume_value=None):
    channel = WorkerChannel(connection, str(task_data["task_id"]))
    answer = channel.request_tool("echo.boom", {})
    if not answer.ok:
        channel.report(FAILED, {"reason": answer.error})
        return
    channel.report(COMPLETED, {"result_ref": "不该走到这"})
"""})
    app.hotloader.refresh()

    task_id = _run(app, executor_ref="crasher.run", task_ref="hello.txt")
    task = wait_for_status(app.kernel, task_id, "failed")

    assert "说炸就炸" in _last_reason(app, task_id, "FAILED")
    called = [item for item in app.kernel.events(task_id) if item.event_type == "FUNCTION_CALLED"]
    assert called, "允许过的调用仍然要留下一条记录"


# ── 停下来等审批

def test_要审批的调用会停下来_批了之后从同一个请求继续(tmp_path: Path):
    app = application(tmp_path, approve=False)
    try:
        task_id = _run(app, executor_ref="guard.run", task_ref="hello.txt")

        paused = wait_for_status(app.kernel, task_id, "paused")
        assert paused.pending_tool_id == "guard.write"
        assert paused.checkpoint_ref == "cp-1"
        assert {"FUNCTION_APPROVAL_REQUESTED", "INTERRUPTED"} <= {
            item.event_type for item in app.kernel.events(task_id)}

        app.facade.submit("approve", {"task_id": task_id, "decision_ref": "用户点了同意"})

        task = wait_for_status(app.kernel, task_id, "succeeded", "failed")
        assert task.status == "succeeded", "批了之后应该从那个 checkpoint 接着跑完"
        events = [item.event_type for item in app.kernel.events(task_id)]
        assert events.count("FUNCTION_CALLED") == 1, "兑现那次调用只记一条"
        assert "APPROVED" in events
        assert task.state_version == len(app.kernel.events(task_id))
    finally:
        app.shutdown()


def test_拒了之后恢复_worker_拿到的是拒绝(tmp_path: Path):
    app = application(tmp_path, approve=False)
    try:
        task_id = _run(app, executor_ref="guard.run", task_ref="hello.txt")
        wait_for_status(app.kernel, task_id, "paused")

        app.facade.submit("deny", {"task_id": task_id, "decision_ref": "不批"})

        task = wait_for_status(app.kernel, task_id, "failed")
        assert task.status == "failed", "worker 拿到拒绝之后自己收尾成 failed"
        events = [item.event_type for item in app.kernel.events(task_id)]
        assert "DENIED" in events
        assert "FUNCTION_CALLED" not in events, "拒绝没有执行任何东西"
        assert task.state_version == len(app.kernel.events(task_id))
    finally:
        app.shutdown()


# ── 静默退出与崩溃

def test_什么都没说就退出_也收成终态(tmp_path: Path):
    """**"其他任何异常"真正的落点。** 不然留下一个永远 running 的 Task，
    界面上看不出它是死了还是还在跑。
    """
    app = application(tmp_path)
    try:
        write_package(app.settings.extensions, "quiet", """\
id: quiet
executors:
  - name: quiet.run
    worker: {entrypoint: "worker.py:run"}
""", {"worker.py": SILENT_WORKER})
        app.hotloader.refresh()

        task_id = _run(app, executor_ref="quiet.run")

        task = wait_for_status(app.kernel, task_id, "failed")
        assert "没有报告" in _last_reason(app, task_id, "FAILED")
        assert task.status == "failed"
    finally:
        app.shutdown()


def test_入口里抛异常_理由要传回来(tmp_path: Path):
    app = application(tmp_path)
    try:
        write_package(app.settings.extensions, "angry", """\
id: angry
executors:
  - name: angry.run
    worker: {entrypoint: "worker.py:run"}
""", {"worker.py": BOOM_WORKER})
        app.hotloader.refresh()

        task_id = _run(app, executor_ref="angry.run")

        task = wait_for_status(app.kernel, task_id, "failed")
        assert "我在入口里炸了" in _last_reason(app, task_id, "FAILED")
    finally:
        app.shutdown()


def test_正文读不到就别起进程(app, tmp_path: Path):
    """旧代码把读不到留到 worker 里炸，于是 Task 已经 running、**日程看着像跑过了**。"""
    created = app.facade.submit("create_task", {"summary": "缺文件", "executor_ref": "echo.run",
                                                "task_ref": "没有这个文件.txt"})
    task_id = created.data["task_id"]

    app.facade.submit("start_task", {"task_id": task_id})

    task = app.kernel.get_task(task_id)
    assert task.status == "failed"
    assert "找不到任务正文" in _last_reason(app, task_id, "FAILED")
    assert app.controller.running_ids() == (), "没有进程被起过"


# ── 命令面

def test_执行者不存在_当场拒(app):
    with pytest.raises(CommandRejected) as caught:
        app.facade.submit("create_task", {"summary": "x", "executor_ref": "没有这个执行者"})

    assert "没有这个执行者" in str(caught.value)


def test_拿不到能跑的执行者_也当场拒(app, tmp_path: Path):
    """**基座可以被直接引用，而它可能没有模型**——拦在建 Task 的那一刻。"""
    write_package(app.settings.extensions, "loop", """\
id: loop
executors:
  - name: loop.run
    needs_llm: true
    worker: {entrypoint: "worker.py:run"}
""", {"worker.py": SILENT_WORKER})
    app.hotloader.refresh()

    with pytest.raises(CommandRejected) as caught:
        app.facade.submit("create_task", {"summary": "x", "executor_ref": "loop.run"})

    assert "模型" in str(caught.value)


def test_取消会真的把进程叫停(app):
    created = app.facade.submit("create_task", {"summary": "长活", "executor_ref": "slow.run"})
    task_id = created.data["task_id"]
    app.facade.submit("start_task", {"task_id": task_id})
    wait_until(lambda: task_id in app.controller.running_ids())

    result = app.facade.submit("cancel", {"task_id": task_id, "reason": "不跑了"})

    assert result.data["status"] == "cancelled"
    assert task_id not in app.controller.running_ids(), "句柄要收掉"
    assert app.launches.open_for(task_id) is None, "启动记录也要收掉"


# ── 关停

def test_关停之后没有句柄留着(app):
    task_id = _run(app, executor_ref="echo.run", task_ref="hello.txt")

    app.shutdown()

    assert app.controller.running_ids() == ()
    assert app.stop.is_set()


def _last_reason(app, task_id: str, event_type: str) -> str:
    events = [item for item in app.kernel.events(task_id) if item.event_type == event_type]
    return str(events[-1].payload.get("reason", ""))
