"""一个委托的一生。

只问外面看得见的事：它现在什么状态、它留下了什么历史、历史和状态对不对得上。
**不碰内部结构**——没有一处断言某个类长什么样、某个方法怎么调。
"""
from __future__ import annotations

import json

import pytest

from src.core.errors import CommandRejected, NotFound
from src.core.task import Cancel
from src.storage.control import SqliteCoreStore
from tests.support.newcore import (
    ask_for_tool, approve, fail, finish, history, resume, start, status, stop_for_approval,
)


def test_刚建好的委托就是在跑的(kernel):
    """建出来就是要干活的——没有一个"等着开始"的中间态。"""
    task = start(kernel)

    assert status(kernel, task) == "running"
    assert history(kernel, task) == ["TASK_CREATED"]


def test_正常结束会留下一个成功的结论(kernel):
    task = start(kernel)
    finish(kernel, task, result_ref="res://报告")

    assert status(kernel, task) == "succeeded"
    assert history(kernel, task) == ["TASK_CREATED", "COMPLETED"]


def test_参数永不入链_链上只有它的哈希(kernel):
    """**参数是隐私性质，不是优化**：链上只留一个哈希（`payload["params_hash"]`）。

    而那个哈希由**宿主**从请求现算——worker 递过来的不算数（`core/capability.py` 规则一）。
    """
    task = start(kernel)
    ask_for_tool(kernel, task, decision="allow", params={"text": "口令：芝麻开门"})

    chain = json.dumps([item.payload for item in kernel.events(task)], ensure_ascii=False)

    assert "芝麻开门" not in chain, "参数原文进了链"
    assert "params_hash" in chain


def test_结果本身不进内核只留一个引用(kernel):
    """ADR-008：内核凭什么替一个它不认识的执行者决定结果存哪、存多久。"""
    task = start(kernel)
    finish(kernel, task, result_ref="res://报告")

    stored = kernel.get_task(task)
    assert "res://报告" not in str(vars(stored))
    assert kernel.events(task)[-1].payload["result_ref"] == "res://报告"


def test_出错会留下失败和原因(kernel):
    task = start(kernel)
    fail(kernel, task, reason="工具连不上")

    assert status(kernel, task) == "failed"
    assert history(kernel, task) == ["TASK_CREATED", "FAILED"]
    assert kernel.events(task)[-1].payload["reason"] == "工具连不上"


def test_可以取消(kernel):
    task = start(kernel)
    kernel.cancel_task(Cancel(task_id=task, reason="用户不要了"))

    assert status(kernel, task) == "cancelled"


def test_走到头之后不能再动(kernel):
    """**重复提交是被状态机挡下来的**——不是靠一张幂等表。"""
    task = start(kernel)
    finish(kernel, task)

    with pytest.raises(CommandRejected):
        finish(kernel, task)
    with pytest.raises(CommandRejected):
        fail(kernel, task)
    assert status(kernel, task) == "succeeded"


def test_不存在的委托问不出来(kernel):
    with pytest.raises(NotFound):
        kernel.get_task("task-没有这个")


def test_每一次状态变化都在历史里留下一条(kernel):
    """这份设计最硬的一条：**链上的条数就是 `state_version`**。

    走一条完整的审批时间线，每一步都对一次账——漏记一条、或者只改状态不记事件，
    这里立刻会掉。
    """
    task = start(kernel)

    def account(step: str) -> None:
        assert kernel.get_task(task).state_version == len(kernel.events(task)), step

    account("建好")
    ask_for_tool(kernel, task); account("请求审批")
    stop_for_approval(kernel, task); account("停下来等")
    approve(kernel, task); account("批准")
    resume(kernel, task); account("恢复")
    ask_for_tool(kernel, task, decision="allow"); account("兑现")
    finish(kernel, task); account("结束")


def test_一条完整的审批时间线长这样(kernel):
    """把"发生了什么"完整读出来——它同时也是一份**格式契约**：
    顺序是这样，中间不多不少。"""
    task = start(kernel)
    ask_for_tool(kernel, task)
    stop_for_approval(kernel, task)
    approve(kernel, task)
    resume(kernel, task)
    ask_for_tool(kernel, task, decision="allow")
    finish(kernel, task)

    assert history(kernel, task) == [
        "TASK_CREATED",
        "FUNCTION_APPROVAL_REQUESTED",
        "INTERRUPTED",
        "APPROVED",
        "RESUMED",
        "FUNCTION_CALLED",
        "COMPLETED",
    ]


def test_历史是按发生顺序排的(kernel):
    task = start(kernel)
    ask_for_tool(kernel, task)
    stop_for_approval(kernel, task)

    moments = [event.occurred_at for event in kernel.events(task)]
    assert moments == sorted(moments)


def test_重启之后事实还在(store, kernel):
    """换一个进程、重新打开同一个库——委托和历史都还在。"""
    from src.core.kernel import Kernel

    task = start(kernel)
    finish(kernel, task, result_ref="res://报告")

    reopened = Kernel(SqliteCoreStore(store.path))

    assert status(reopened, task) == "succeeded"
    assert history(reopened, task) == ["TASK_CREATED", "COMPLETED"]
