"""审计链：**不可删、不可改、动了要看得出来**。

这是那个"不可删的事实"唯一能被检验的地方。两条边界必须分得清：

- **尾部撕了一角**——最后一行自己坏了。可以截断（要备份、要精确确认）
- **中间被动过**——链断了，或中间某行坏了。**不许截断**，那是"内部损坏"，只能人工处置

差别很要紧：光看"哪一行失败"分不出来，因为删掉中间一条之后，
**剩下的最后一行恰好也会在链上失败**。
"""
from __future__ import annotations

import sqlite3

import pytest

from src.core.errors import EventStoreCorrupted
from src.storage.control import SqliteCoreStore
from tests.support.newcore import ask_for_tool, finish, history, start, stop_for_approval


def _three_events(kernel) -> str:
    """造一条有三个事件的委托——中间才有得删。"""
    task = start(kernel)
    ask_for_tool(kernel, task)
    stop_for_approval(kernel, task)
    return task


def _event_ids(store) -> list[str]:
    conn = sqlite3.connect(store.path)
    try:
        return [str(r[0]) for r in conn.execute(
            "SELECT event_id FROM control_events ORDER BY rowid").fetchall()]
    finally:
        conn.close()


def _edit(store, sql: str, args=()) -> None:
    conn = sqlite3.connect(store.path)
    try:
        conn.execute(sql, args)
        conn.commit()
    finally:
        conn.close()


# ── 动了就要看得出来

def test_改动历史里的内容会被发现(store, kernel):
    task = _three_events(kernel)
    _edit(store, "UPDATE control_events SET payload_json='{}' WHERE task_id=?", (task,))

    report = store.inspect()

    assert report.invalid_events > 0
    assert not report.tail_corruption


def test_删掉中间一条会被发现(store, kernel):
    """**删掉的是中间那条**——而剩下的最后一行也会因此接不上。"""
    _three_events(kernel)
    middle = _event_ids(store)[1]
    _edit(store, "DELETE FROM control_events WHERE event_id=?", (middle,))

    report = store.inspect()

    assert report.invalid_events > 0
    assert report.internal_corruption is True
    assert report.tail_corruption is False


def test_整条链还在的时候是干净的(store, kernel):
    _three_events(kernel)

    report = store.inspect()

    assert report.invalid_events == 0
    assert report.errors == ()


# ── 坏链之后不许再往下写

def test_发现损坏之后停止追加(store, kernel):
    """**不在不可信的历史上制造新的控制事实。**"""
    task = _three_events(kernel)
    _edit(store, "UPDATE control_events SET payload_json='{}' WHERE task_id=?", (task,))
    store.recover()

    with pytest.raises(EventStoreCorrupted):
        start(kernel, summary="还想再建一个")


def test_内部损坏不许截断(store, kernel):
    _three_events(kernel)
    _edit(store, "DELETE FROM control_events WHERE event_id=?", (_event_ids(store)[1],))
    store.recover()

    with pytest.raises(EventStoreCorrupted):
        store.repair_tail(_event_ids(store)[-1:], confirm=True)


# ── 尾部那一角可以撕掉

def test_尾部撕了一角可以截断(store, kernel):
    task = _three_events(kernel)
    last = _event_ids(store)[-1]
    # 只动**最后一行**：它自己坏了，链没断。
    _edit(store, "UPDATE control_events SET checksum='坏了' WHERE event_id=?", (last,))

    report = store.repair_tail([last], confirm=True)

    assert report.repaired is True
    assert report.removed_event_ids == (last,)
    assert store.inspect().invalid_events == 0
    assert history(kernel, task) == ["TASK_CREATED", "FUNCTION_APPROVAL_REQUESTED"]


def test_截断前会留一份备份(store, kernel):
    _three_events(kernel)
    last = _event_ids(store)[-1]
    _edit(store, "UPDATE control_events SET checksum='坏了' WHERE event_id=?", (last,))

    report = store.repair_tail([last], confirm=True)

    from pathlib import Path

    assert report.backup_path
    assert Path(report.backup_path).exists()


def test_截断要精确列出待删的那些(store, kernel):
    """删的是"不可删的事实"，所以要你说得出是哪几条——说错了就拒绝。"""
    _three_events(kernel)
    last = _event_ids(store)[-1]
    _edit(store, "UPDATE control_events SET checksum='坏了' WHERE event_id=?", (last,))

    with pytest.raises(EventStoreCorrupted):
        store.repair_tail(["evt-不是它"], confirm=True)


def test_没有确认就什么都不做(store, kernel):
    _three_events(kernel)
    last = _event_ids(store)[-1]
    _edit(store, "UPDATE control_events SET checksum='坏了' WHERE event_id=?", (last,))

    report = store.repair_tail([last], confirm=False)

    assert report.repaired is False
    assert store.inspect().invalid_events > 0


def test_修好之后又能写了(store, kernel):
    _three_events(kernel)
    last = _event_ids(store)[-1]
    _edit(store, "UPDATE control_events SET checksum='坏了' WHERE event_id=?", (last,))
    store.repair_tail([last], confirm=True)

    task = start(kernel, summary="修好之后再建一个")

    assert history(kernel, task) == ["TASK_CREATED"]


# ── 一个委托的历史是它自己那条链

def test_一个委托的历史不会被别人的掺进来(store, kernel):
    first = start(kernel, summary="甲")
    second = start(kernel, summary="乙")
    finish(kernel, first)

    assert history(kernel, first) == ["TASK_CREATED", "COMPLETED"]
    assert history(kernel, second) == ["TASK_CREATED"]


def test_重开一个库读到的是同一份历史(store, kernel):
    from src.core.kernel import Kernel

    task = _three_events(kernel)

    reopened = SqliteCoreStore(store.path)

    assert reopened.inspect().invalid_events == 0
    assert history(Kernel(reopened), task) == history(kernel, task)
