"""日程派发：**到点了建一个 Task，同一分钟只建一次。**

派发是**两步**（建 Task + 启动它），中间会断——所以这里最要紧的不是"跑得对"，
是"断在哪一步都还认得出来"：

- 同一分钟第二次 tick 不再派发（occurrence 幂等）
- **建成了但没起成**：记录里留着 `task_id`，下一个 tick 只补启动，不再建一个
- 一条坏日程不挡住同一分钟里的别的日程
- **错过的那一分钟不补**——补偿不是它今天会做的事，那是写下来的欠账
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.core.errors import CommandRejected
from src.extensions.manifest import Schedule, cron_matches, parse_entry
from src.gateway.directory.schedules import ScheduleDirectory
from src.tasks.scheduler import CREATED, DISPATCHED, FAILED, DispatchLog, Scheduler
from tests.support.newtree import application, wait_for_status

SHANGHAI = timezone(timedelta(hours=8))


class FakeDispatcher:
    """只记账的派发口。**它让"两步断在哪"变成一件能摆布的事。**"""

    def __init__(self) -> None:
        self.created: list[dict] = []
        self.started: list[str] = []
        self.fail_start = False
        self.fail_create = False

    def create(self, *, summary: str, executor_ref: str, task_ref: str) -> str:
        if self.fail_create:
            raise RuntimeError("建 Task 这一步就炸了")
        task_id = f"task-{len(self.created) + 1}"
        self.created.append({"task_id": task_id, "summary": summary,
                             "executor_ref": executor_ref, "task_ref": task_ref})
        return task_id

    def start(self, task_id: str) -> None:
        if self.fail_start:
            raise RuntimeError("启动这一步炸了")
        self.started.append(task_id)


def scheduler(tmp_path: Path, schedules: list[Schedule], dispatcher) -> Scheduler:
    directory = ScheduleDirectory()
    directory.replace(tuple(schedules))
    return Scheduler(dispatcher, directory, path=tmp_path / "dispatches.sqlite")


def daily(name: str = "echo.daily", **overrides) -> Schedule:
    fields = {"name": name, "cron": "0 8 * * *", "timezone": "Asia/Shanghai",
              "task_ref": "hello.txt", "executor_ref": "echo.run"}
    fields.update(overrides)
    return Schedule(**fields)


def minute(year=2026, month=9, day=28, hour=8, minute_=0, tz=SHANGHAI) -> datetime:
    return datetime(year, month, day, hour, minute_, tzinfo=tz)


# ── cron

@pytest.mark.parametrize("expression, moment, expected", [
    ("0 8 * * *", minute(hour=8, minute_=0), True),
    ("0 8 * * *", minute(hour=8, minute_=1), False),
    ("*/15 * * * *", minute(hour=3, minute_=45), True),
    ("*/15 * * * *", minute(hour=3, minute_=46), False),
    ("0 8 * * 1-5", minute(hour=8), True),        # 2026-09-28 是星期一
    ("0 8 * * 0,6", minute(hour=8), False),
    ("0 8 1 * *", minute(hour=8), False),
])
def test_cron_匹配(expression, moment, expected):
    assert cron_matches(expression, moment) is expected


def test_cron_写坏了当场说():
    """**一句写坏的 cron 不是一份合法声明**——它在写进去的时候就该被拒，
    不是等到某天早上它没跑、而用户以为它跑过了。"""
    with pytest.raises(ValueError):
        cron_matches("每天八点", minute())
    with pytest.raises(ValueError):
        parse_entry({"name": "x", "cron": "每天八点", "task_ref": "a"}, "schedules")


# ── 一次派发

def test_到点就建一个_Task_并启动它(tmp_path: Path):
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [daily()], dispatcher)

    records = engine.tick(minute())

    assert [item["executor_ref"] for item in dispatcher.created] == ["echo.run"]
    assert dispatcher.started == ["task-1"]
    assert records[0].status == DISPATCHED
    assert records[0].task_id == "task-1"


def test_同一分钟第二次_tick_不再派发(tmp_path: Path):
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [daily()], dispatcher)

    engine.tick(minute())
    again = engine.tick(minute())

    assert len(dispatcher.created) == 1, "occurrence 幂等没了"
    assert again[0].status == DISPATCHED


def test_下一分钟是新的一次(tmp_path: Path):
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [daily()], dispatcher)

    engine.tick(minute(hour=8, minute_=0))
    engine.tick(minute(hour=9, minute_=0))

    assert len(dispatcher.created) == 1, "这一条是 8 点整的日程，9 点不该派发"


def test_建成了但没起成_下一个_tick_只补启动(tmp_path: Path):
    """**两步之间会断。** 记录里留着 `task_id`，所以重试不会多建一个 Task。"""
    dispatcher = FakeDispatcher()
    dispatcher.fail_start = True
    engine = scheduler(tmp_path, [daily()], dispatcher)

    first = engine.tick(minute())

    assert first[0].status == FAILED
    assert first[0].task_id == "task-1", "**建成的那个要留着**——重试用得着它"
    assert "启动这一步炸了" in first[0].detail

    dispatcher.fail_start = False
    second = engine.tick(minute())

    assert len(dispatcher.created) == 1, "不该再建一个"
    assert dispatcher.started == ["task-1"]
    assert second[0].status == DISPATCHED


def test_建都没建成_记录里没有_task_id(tmp_path: Path):
    dispatcher = FakeDispatcher()
    dispatcher.fail_create = True
    engine = scheduler(tmp_path, [daily()], dispatcher)

    record = engine.tick(minute())[0]

    assert record.status == FAILED
    assert record.task_id == ""


def test_一条坏日程不挡住别的(tmp_path: Path):
    """**失败要留痕，而且要接着走。** 不然"从来没跑过"和"跑了但失败了"长得一样。"""
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [
        daily("时区坏的", timezone="Mars/Olympus"),
        daily("好的"),
    ], dispatcher)

    records = engine.tick(minute())

    assert [item["executor_ref"] for item in dispatcher.created] == ["echo.run"]
    assert {item.schedule_id: item.status for item in records} == {
        "时区坏的": FAILED, "好的": DISPATCHED}


def test_没有_executor_ref_当场记一条失败(tmp_path: Path):
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [daily("没写谁跑", executor_ref="")], dispatcher)

    record = engine.tick(minute())[0]

    assert record.status == FAILED
    assert "executor_ref" in record.detail
    assert dispatcher.created == []


def test_时区写坏了也要留痕(tmp_path: Path):
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [daily("时区坏了", timezone="Mars/Olympus")], dispatcher)

    record = engine.tick(minute())[0]

    assert record.status == FAILED
    assert "时区" in record.detail


def test_关着的日程不派发(tmp_path: Path):
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [daily(enabled=False)], dispatcher)

    assert engine.tick(minute()) == []
    assert dispatcher.created == []


# ── 手动触发

def test_手动跑一次_和到点派发走同一条路(tmp_path: Path):
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [daily()], dispatcher)

    task_id = engine.trigger("echo.daily")

    assert task_id == "task-1"
    assert engine.log.recent()[0].status == DISPATCHED


def test_手动跑一条不存在的日程_当场拒(tmp_path: Path):
    engine = scheduler(tmp_path, [daily()], FakeDispatcher())

    with pytest.raises(KeyError):
        engine.trigger("没有这条")


# ── 记录

def test_记录会清老的不让它无限长(tmp_path: Path):
    """一条时区写错的日程每天能写 1440 条——**"只增不减"是会咬人的**。"""
    import sqlite3

    log = DispatchLog(tmp_path / "d.sqlite")
    log.save("x:old", "x", status=DISPATCHED)
    log.save("x:now", "x", status=DISPATCHED)
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    connection = sqlite3.connect(log.path)
    connection.execute("UPDATE dispatches SET updated_at = ? WHERE occurrence_key = 'x:old'",
                       (old,))
    connection.commit()
    connection.close()

    removed = log.prune(keep_days=7)

    assert removed == 1
    assert [item.occurrence_key for item in log.recent()] == ["x:now"]


def test_occurrence_键不带时区偏移(tmp_path: Path):
    """**改一次时区声明，历史键要还对得上。** 带上偏移就全部对不上了。"""
    dispatcher = FakeDispatcher()
    engine = scheduler(tmp_path, [daily()], dispatcher)

    engine.tick(minute())

    assert engine.log.recent()[0].occurrence_key == "echo.daily:2026-09-28T08:00"


# ── 真系统里跑一次

def test_派发出来的_Task_真的跑起来了(tmp_path: Path):
    app = application(tmp_path)
    try:
        app.scheduler.clock = lambda: datetime(2026, 9, 28, 0, 0, tzinfo=timezone.utc)

        records = app.scheduler.tick()

        dispatched = [item for item in records if item.schedule_id == "echo.daily"]
        assert dispatched and dispatched[0].status == DISPATCHED
        task = wait_for_status(app.kernel, dispatched[0].task_id, "succeeded", "failed")
        assert task.status == "succeeded"
        assert task.executor_ref == "echo.run"
    finally:
        app.shutdown()


# ── 删一条日程：它拥有它的子 Task

def 派发一次(app, clock: datetime) -> str:
    """把时钟拨到那一刻、派发一次，返回子 Task 的 id。"""
    app.scheduler.clock = lambda: clock
    records = app.scheduler.tick()
    dispatched = [item for item in records if item.task_id]
    assert dispatched, "这一分钟什么都没派出去"
    return dispatched[0].task_id


def test_没有输入引用的日程照样跑得起来(tmp_path: Path):
    """`task_ref` 留空 = **没有正文**，不是"跑不起来"。

    这是那一栏从必填挪到可选的全部理由：`inputs.read` 在起进程**之前**读它，
    读不到就把这次运行收成 failed——编一个不存在的文件名，就是每一次派发都失败。
    """
    app = application(tmp_path)
    try:
        app.facade.submit("manifest.create", {
            "target": "schedule", "name": "no-input.daily",
            "data": {"name": "no-input.daily", "cron": "0 8 * * *",
                     "timezone": "Asia/Shanghai", "executor_ref": "echo.run"}})

        task_id = app.facade.submit("schedule.trigger", {"name": "no-input.daily"}).data["task_id"]
        task = wait_for_status(app.kernel, task_id, "succeeded", "failed")

        assert task.status == "succeeded"
        assert task.task_ref == ""
    finally:
        app.shutdown()


def test_删一条日程连它的子_Task_一起删掉(tmp_path: Path):
    """子 Task 在外层看不见，编排台又跟着声明一起没——所以删日程得连它们一起处理。

    **顺序也是规矩：先清 Task，再删声明。** 反过来的话，删完声明就再也说不出
    这些 Task 归谁了（派发记录里那个 `schedule_id` 指向一条不存在的日程）。
    """
    app = application(tmp_path)
    try:
        task_id = 派发一次(app, datetime(2026, 9, 28, 0, 0, tzinfo=timezone.utc))
        wait_for_status(app.kernel, task_id, "succeeded", "failed")

        outcome = app.facade.submit("schedule.delete", {"name": "echo.daily"})

        assert outcome.data["tasks_forgotten"] == [task_id]
        # Task 那一行没了
        assert all(task.task_id != task_id for task in app.kernel.list_tasks())
        # 声明也没了
        assert app.registry.schedules.get("echo.daily") is None
        # **事件链一条都不动**：删掉的是 Task 那一行，不是"这里发生过什么"
        assert [event.event_type for event in app.kernel.events(task_id)]
    finally:
        app.shutdown()


def test_还在跑的子_Task_先取消_再归档_再删(tmp_path: Path):
    """`slow.run` 要睡两分钟：删日程的时候它还开着。

    **不取消的话后面两步都会被拒**（归档只收终态的），而"日程都删了、它还在跑"
    也不是用户要的。取消的理由写进事件链——那条 Task 是被谁、为什么拿掉的，
    事后读得出来。
    """
    app = application(tmp_path)
    try:
        app.facade.submit("manifest.create", {
            "target": "schedule", "name": "slow.daily",
            "data": {"name": "slow.daily", "cron": "0 8 * * *",
                     "timezone": "Asia/Shanghai", "task_ref": "hello.txt",
                     "executor_ref": "slow.run"}})
        task_id = app.facade.submit("schedule.trigger", {"name": "slow.daily"}).data["task_id"]
        wait_for_status(app.kernel, task_id, "running")

        app.facade.submit("schedule.delete", {"name": "slow.daily"})

        assert app.registry.schedules.get("slow.daily") is None
        assert all(task.task_id != task_id for task in app.kernel.list_tasks())
        # 它在被删之前**真的被取消过**：那条 CANCELLED 留在链上
        events = [event.event_type for event in app.kernel.events(task_id)]
        assert "CANCELLED" in events
        assert events.index("CANCELLED") < events.index("TASK_ARCHIVED")
    finally:
        app.shutdown()


def test_删日程不走_manifest_delete(tmp_path: Path):
    """那条路上没有子 Task 这一圈——放行的话会留下一批没人认领的 Task。

    拒绝要说清**该走哪条**，不然调用方只能猜。
    """
    app = application(tmp_path)
    try:
        task_id = 派发一次(app, datetime(2026, 9, 28, 0, 0, tzinfo=timezone.utc))
        wait_for_status(app.kernel, task_id, "succeeded", "failed")

        with pytest.raises(CommandRejected) as refusal:
            app.facade.submit("manifest.delete", {"target": "schedule", "name": "echo.daily"})

        assert "schedule.delete" in str(refusal.value)
        # **什么都没动**：声明还在，Task 也还在
        assert app.registry.schedules.get("echo.daily") is not None
        assert any(task.task_id == task_id for task in app.kernel.list_tasks())
    finally:
        app.shutdown()
