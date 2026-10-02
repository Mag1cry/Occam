"""**输出**：要送到外面去的那件事——形状、派生、以及"什么时候算悬着"。

它是**投影**（从 Task 现算，不存状态），所以这些用例几乎都是"什么条件下派生、
什么条件下不派生"。不派生的那几条同样要紧：**送一件点了会失败的事，比不送糟**。
"""
from __future__ import annotations

from pathlib import Path

from src.core.event import new_event, subject_of
from src.gateway.output.output import APPROVAL, for_task, from_fact, standing
from tests.support.newtree import application, wait_for_status


def 停在待批(app) -> str:
    """跑一个要审批的 Task，等它停在 `paused`。"""
    task_id = app.facade.submit("create_task", {
        "summary": "守卫", "executor_ref": "guard.run",
        "task_ref": "hello.txt"}).data["task_id"]
    app.facade.submit("start_task", {"task_id": task_id})
    wait_for_status(app.kernel, task_id, "paused")
    return task_id


def test_停在待批就是一份悬着的输出(tmp_path: Path):
    app = application(tmp_path, approve=False)
    try:
        task_id = 停在待批(app)

        found = standing(app.kernel)

        assert [item.kind for item in found] == [APPROVAL]
        one = found[0]
        # 身份稳定：前端、飞书都靠它去重（重连、重启、刷新都不该当成第二件事）
        assert one.ref == f"task:{task_id}:approval"
        assert one.target_ref == f"task:{task_id}"
        # 摘要里**只有内核说过的话**：要调哪个工具（reason_ref 是那句"为什么"）
        assert "guard.write" in one.summary
        assert [action.command for action in one.actions] == ["approve", "deny"]
    finally:
        app.shutdown()


def test_批过之后就不再悬着(tmp_path: Path):
    app = application(tmp_path, approve=False)
    try:
        task_id = 停在待批(app)
        assert standing(app.kernel)

        app.facade.submit("approve", {"task_id": task_id, "decision_ref": "test:probe"})
        wait_for_status(app.kernel, task_id, "succeeded", "failed", "paused")

        # 定了案就不是待办，是历史——再送一次等于问一件已经做完的事
        assert [item.ref for item in standing(app.kernel)] == []
    finally:
        app.shutdown()


def test_还在跑的不算悬着():
    """停之前送出去，外面点"批准"会被内核拒（`Task 没有待处理的审批`）。

    所以判据里有 `status == "paused"` 这一条——**送一件点了会失败的事，比不送糟**。
    """
    from types import SimpleNamespace

    running = SimpleNamespace(task_id="task-x", has_pending=True, pending_decision="pending",
                              status="running", pending_tool_id="guard.write",
                              pending_reason_ref="", summary="x")
    paused = SimpleNamespace(**{**vars(running), "status": "paused"})

    assert for_task(running) is None
    assert for_task(paused) is not None


def test_事件驱动听的是_INTERRUPTED_那一刻(tmp_path: Path):
    """`FUNCTION_APPROVAL_REQUESTED` 发生时 **Task 还没停**——那时候送出去，
    外面点"批准"会被拒。停稳了才是能办事的时候，而那是 `INTERRUPTED`。"""
    app = application(tmp_path, approve=False)
    try:
        task_id = 停在待批(app)
        task = app.kernel.get_task(task_id)

        # 别的种类一律不产出
        for kind in ("TASK_CREATED", "FUNCTION_CALLED", "APPROVED", "COMPLETED"):
            assert from_fact(app.kernel, new_event(kind, subject_of(task_id),
                                                   task_id=task_id)) is None
        # 停稳了的那一条才产出
        assert from_fact(app.kernel, new_event("INTERRUPTED", subject_of(task_id),
                                               task_id=task_id)) is not None
        assert for_task(task) is not None
    finally:
        app.shutdown()


def test_快照里带着悬着的输出(tmp_path: Path):
    """前端那条输出路径**不需要投递**：它出现在快照里就是送到了。"""
    from fastapi.testclient import TestClient

    app = application(tmp_path)
    try:
        with TestClient(app.app, client=("127.0.0.1", 51234)) as client:
            payload = client.get("/api/state").json()

        assert payload["outputs"] == []        # 没人在等拍板时是空的，不是缺一格
    finally:
        app.shutdown()


def test_有没有人待批_快照都答得出(tmp_path: Path):
    """夹具的 `client` 是"不用批"的那个世界；这里单独要一个**要批**的世界，
    确认那一格真的会亮。"""
    from fastapi.testclient import TestClient

    app = application(tmp_path, approve=False)
    try:
        task_id = 停在待批(app)

        with TestClient(app.app, client=("127.0.0.1", 51234)) as client:
            outputs = client.get("/api/state").json()["outputs"]

        assert [item["ref"] for item in outputs] == [f"task:{task_id}:approval"]
        assert outputs[0]["actions"][0]["command"] == "approve"
    finally:
        app.shutdown()
