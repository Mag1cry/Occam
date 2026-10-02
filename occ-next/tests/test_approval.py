"""要人批的调用。

这里的每一条都是**性质**，不是"调了这个方法会返回那个"。最要紧的两条：

- **批准过的那一次调用，恢复之后要能自己走通**（不然审批链就断在这儿）
- **批准了甲，绝不能执行乙**（同工具、不同参数）——这是那条"Agent 不能伪造批准"
  的保证唯一会漏的地方
"""
from __future__ import annotations

import pytest

from src.core.errors import CommandRejected, Conflict
from tests.support.newcore import (
    PARAMS, ask_for_tool, approve, deny, history, resume, start, status, stop_for_approval,
)


def _waiting_for_approval(kernel) -> str:
    """建一个委托，让它卡在"等人批"上。**这是审批链的起点。**"""
    task = start(kernel)
    ask_for_tool(kernel, task)
    stop_for_approval(kernel, task)
    return task


# ── 停下来等

def test_要审批的调用不会执行_它会停下来等(kernel):
    task = start(kernel)
    answer = ask_for_tool(kernel, task)

    assert answer.decision == "needs_approval"
    assert status(kernel, task) == "running"        # 还没停，执行者还在跑
    assert history(kernel, task) == ["TASK_CREATED", "FUNCTION_APPROVAL_REQUESTED"]
    assert "FUNCTION_CALLED" not in history(kernel, task)


def test_人批之前同一个请求一直被挡着(kernel):
    task = start(kernel)
    ask_for_tool(kernel, task)

    again = ask_for_tool(kernel, task, decision="allow")

    assert again.decision == "needs_approval"
    assert "FUNCTION_CALLED" not in history(kernel, task)


def test_一次只等一件事批(kernel):
    """**还没批的那一件挡路**——说不清在等哪件，就停不下来。"""
    task = start(kernel)
    ask_for_tool(kernel, task)

    with pytest.raises(CommandRejected):
        ask_for_tool(kernel, task, params={"path": "别的东西.txt"}, decision="allow")


def test_停下来的时候必须指名是哪件(kernel):
    task = start(kernel)
    ask_for_tool(kernel, task)

    with pytest.raises(CommandRejected):
        stop_for_approval(kernel, task, tool="workspace.list_dir")

    assert status(kernel, task) == "running"


# ── 兑现：批准过的那一次要能走通

def test_批准并恢复之后_同一次调用直接放行(kernel):
    """**审批链的接点。** 执行者恢复之后会把同一个请求原样再发一次——
    认出"这就是批过的那一次"，靠的是请求内容本身，不是谁报上来的一个键。
    """
    task = _waiting_for_approval(kernel)
    approve(kernel, task)
    resume(kernel, task)

    answer = ask_for_tool(kernel, task)          # 同一个请求，原样重发

    assert answer.decision == "allow"
    assert answer.data["decision_source"] == "approved"
    assert history(kernel, task)[-1] == "FUNCTION_CALLED"


def test_兑现之后那次审批就用掉了(kernel):
    """批一次只能放行一次——不然一次批准就是个万能通行证。"""
    task = _waiting_for_approval(kernel)
    approve(kernel, task)
    resume(kernel, task)
    ask_for_tool(kernel, task)

    second = ask_for_tool(kernel, task, decision="allow")

    assert second.data.get("decision_source") == "declared"


# ── 绕过：批准了甲不能执行乙

def test_批准了甲不能执行乙(kernel):
    """**同工具、不同参数**——旧代码在这里是直接放行的。

    "批准的是甲、执行的是乙"是那条保证唯一会漏的地方：判决由谁做（进程边界）
    和判决兑给了谁（请求指纹）是两件事，缺一个另一个就白做了。
    """
    task = _waiting_for_approval(kernel)
    approve(kernel, task)
    resume(kernel, task)

    other = ask_for_tool(kernel, task, params={"path": "机密.txt"}, reason="换个文件")

    assert other.decision != "allow"
    assert other.decision == "needs_approval"
    assert "FUNCTION_CALLED" not in history(kernel, task)


# ── 拒绝

def test_拒绝之后同一次调用被拒(kernel):
    task = _waiting_for_approval(kernel)
    deny(kernel, task)
    resume(kernel, task)

    answer = ask_for_tool(kernel, task)

    assert answer.decision == "deny"
    assert "FUNCTION_CALLED" not in history(kernel, task)


def test_拒绝不留任何痕迹(kernel):
    """**拒绝没有改变任何东西，所以没有可记的事。** 状态和历史都不动。"""
    task = _waiting_for_approval(kernel)
    deny(kernel, task)
    resume(kernel, task)
    before = (kernel.get_task(task).state_version, len(kernel.events(task)))

    ask_for_tool(kernel, task)

    assert (kernel.get_task(task).state_version, len(kernel.events(task))) == before


def test_被拒之后换个说法要重新判(kernel):
    task = _waiting_for_approval(kernel)
    deny(kernel, task)
    resume(kernel, task)
    ask_for_tool(kernel, task)                       # 消耗掉那次拒绝

    other = ask_for_tool(kernel, task, params={"path": "另一个.txt"}, reason="换一个")

    assert other.decision == "needs_approval"        # 重新问，不是沿用旧拒绝


# ── 审批本身

def test_重复批准是空转不留痕(kernel):
    task = _waiting_for_approval(kernel)
    approve(kernel, task)
    before = (kernel.get_task(task).state_version, len(kernel.events(task)))

    approve(kernel, task)

    assert (kernel.get_task(task).state_version, len(kernel.events(task))) == before


def test_不能把批过的反过来拒(kernel):
    task = _waiting_for_approval(kernel)
    approve(kernel, task)

    with pytest.raises(CommandRejected):
        deny(kernel, task)


def test_没有待批的事就不能恢复(kernel):
    task = start(kernel)
    ask_for_tool(kernel, task)
    stop_for_approval(kernel, task)

    with pytest.raises(CommandRejected):
        resume(kernel, task)          # 还没批呢


def test_断点对不上不能恢复(kernel):
    task = _waiting_for_approval(kernel)
    approve(kernel, task)

    with pytest.raises(Conflict):
        resume(kernel, task, checkpoint="另一个断点")


def test_断点必须由执行者给(kernel):
    task = start(kernel)
    ask_for_tool(kernel, task)

    with pytest.raises(CommandRejected):
        stop_for_approval(kernel, task, checkpoint="")
