"""归档与删除：**一条走得通的路**。

"有历史引用就不许删"是对的——但引用一旦存在就没有出路，那就成了一道单向门：
用户说"这个智能体我不要了"，而系统答"它上个月跑过三个任务"。**没有出路的安全
不是安全，是死锁。**

所以这条路是三步：

```text
跑完  →  归档  →  删除
         ↑ 那道确认门：删不可撤销，先收进档案馆看一眼
```

三步各留各的痕：归档是**一条事件**（进链），删除只拿走 Task 那一行——
**事件链一条都不动**（它是"这里发生过什么"的记忆，删掉会当场扯断 `prev_hash`）。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.core.errors import CommandRejected, Conflict
from tests.support.newtree import application, wait_for_status


@pytest.fixture
def app(tmp_path: Path):
    application_ = application(tmp_path)
    yield application_
    application_.shutdown()


def _finished(app, **payload) -> str:
    """跑一个 Task 到底（成功），返回它的 id。"""
    created = app.facade.submit("create_task", {"summary": "跑一次", **payload})
    task_id = created.data["task_id"]
    app.facade.submit("start_task", {"task_id": task_id})
    wait_for_status(app.kernel, task_id, "succeeded", "failed", "cancelled")
    return task_id


# ── 三步

def test_跑完_归档_删掉_三步都成立(app):
    task_id = _finished(app, executor_ref="echo.run", task_ref="hello.txt")
    assert app.kernel.get_task(task_id).archived is False

    app.facade.submit("archive", {"task_id": task_id})
    assert app.kernel.get_task(task_id).archived is True
    # **它还在**：归档是"我不管它了"，不是"它没了"
    assert app.kernel.get_task(task_id).status == "succeeded"

    app.facade.submit("forget", {"task_id": task_id})
    assert app.kernel.list_tasks() == []
    with pytest.raises(Exception):
        app.kernel.get_task(task_id)


def test_归档是一条事件(app):
    """它是**事实**，所以要进链——`state_version` 也跟着 +1。"""
    task_id = _finished(app, executor_ref="echo.run", task_ref="hello.txt")
    before = app.kernel.get_task(task_id).state_version

    app.facade.submit("archive", {"task_id": task_id})

    kinds = [event.event_type for event in app.kernel.events(task_id)]
    assert "TASK_ARCHIVED" in kinds
    assert app.kernel.get_task(task_id).state_version == before + 1


def test_删除不动事件链(app):
    """**记忆不跟着一起删。**

    事件那张表是一条哈希链（每条的 `prev_hash` 是上一条的 checksum）——
    删掉中间几条，链当场就断。而"不再管它"和"抹掉证据"本来就是两件事。
    """
    task_id = _finished(app, executor_ref="echo.run", task_ref="hello.txt")
    before = len(app.kernel.events(task_id))

    app.facade.submit("archive", {"task_id": task_id})
    app.facade.submit("forget", {"task_id": task_id})

    assert len(app.kernel.events(task_id)) == before + 1


# ── 那两道门

def test_没归档不许删(app):
    """删**不可撤销**，所以它前面站着一道门。"""
    task_id = _finished(app, executor_ref="echo.run", task_ref="hello.txt")

    with pytest.raises(CommandRejected, match="先归档"):
        app.facade.submit("forget", {"task_id": task_id})

    assert app.kernel.get_task(task_id) is not None


def test_还在跑的不能归档(app):
    """一个还在动的东西不是"历史"——把它收起来等于把"它还在动"这件事藏掉。"""
    created = app.facade.submit("create_task", {"summary": "挂着",
                                                "executor_ref": "echo.run",
                                                "task_ref": "hello.txt"})
    task_id = created.data["task_id"]      # 建了但**不起**，它停在 running

    with pytest.raises(CommandRejected, match="只有跑完的"):
        app.facade.submit("archive", {"task_id": task_id})


def test_归档两次是空转_不是改两次(app):
    task_id = _finished(app, executor_ref="echo.run", task_ref="hello.txt")
    app.facade.submit("archive", {"task_id": task_id})

    with pytest.raises(Conflict):
        app.facade.submit("archive", {"task_id": task_id})


# ── 那条因果链：这一步正是"包删不掉了"的出路

def test_删掉归档过的任务之后_那个包才删得掉(app):
    """
    "有引用就不许删"是对的，出路就是这个：**先把引用它的 Task 归档、删掉**，
    然后包就是没人用的了。
    """
    task_id = _finished(app, executor_ref="echo.run", task_ref="hello.txt")

    # 它跑过了：包被钉住
    with pytest.raises(CommandRejected, match="还被"):
        app.facade.submit("manifest.delete", {"target": "package", "name": "echo"})

    app.facade.submit("archive", {"task_id": task_id})
    app.facade.submit("forget", {"task_id": task_id})

    app.facade.submit("manifest.delete", {"target": "package", "name": "echo"})
    assert app.registry.package("echo") is None
