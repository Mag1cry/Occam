"""按 cron 派发 + 派发记录。

日程的**定义和开关不在这里**——它们在 `extensions/_schedules/<name>.yaml` 里，改开关就是
改那个文件。这里只剩派发。

## 三条规则

1. **occurrence 幂等**：同一个 `日程 + 分钟` 只能派发一次。靠 `occurrence_key` 记一条，
   下次看见它就跳过。
2. **一条坏日程不能挡住同一分钟里的其它日程**：一次派发失败要落成一条 `failed` 记录，
   然后继续下一条。否则"从来没跑过"和"跑了但失败了"在界面上长得一模一样。
3. **记录要跟着派发走，不能等整条派发完事再写**——理由见下。

## 派发是两步，所以记录也得写两步

一次派发 = 建 Task + 启动它，**两步之间会断**：

| 走到哪 | 记录 |
| --- | --- |
| 建成了 Task | **立刻**把 `task_id` 落进记录，状态推到 `created` |
| 启动成功 | 状态推到 `dispatched` |
| 启动失败 | 状态 `failed` + 原因，**但 `task_id` 留着** |

**下一个 tick 看见 `task_id` 已经有值，就只补启动，不再建一个。**

这条以前是内核的命令幂等键兜着的（命中缓存会把**原来那个 task_id** 还回来）。那个键删掉
之后（`core/store.py`），**兜底的必须是这张记录本身**——否则"建成了但没启动成"重试一次
就多一个 Task。

顺带一条明说的：**失败会被重试**。`_dispatch` 只在状态是 `dispatched` 时提前返回，
所以同一分钟里的下一个 tick 会再试一次。这也是第 3 条必须成立的原因。

## 它是轮询，不是定时

每 30 秒醒一次，看有没有到点的。occurrence 幂等让轮询是安全的，而"算出下一次该在几分
几秒醒"要维护一堆状态——轮询更简单，代价是最多晚 30 秒。**错过的那一分钟不补**——
补偿要另有一套"补哪些、补几次"的规则，而它今天不存在（`OPEN_ISSUES.md` 记着）。

## occurrence 键**不带时区偏移**

旧键是 `f"{name}:{local.isoformat()}"`，里面含着偏移。**改一次 `timezone` 声明，历史键
就全部对不上**，同一分钟可能被派发第二遍。所以这里只用墙上时间（到分钟）：
改时区最坏是**少跑一次**，而不是多跑一次。

## 派发记录表为什么住在这里

**一张表跟着它唯一的读者走。** `dispatches` 只有这个文件读写，所以它就在这里——
不为了"都是 SQLite"和别的表堆到一起，那正是杂物抽屉的起点。
（对比：`launches.py` 单独立文件，因为它有两个读者。）

← 来自 automation/scheduler.py + automation/store.py（日程定义那四张方法已删——
  它们就是"暂停跨不过重启"那个 bug 的第二处说法）
"""
from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from ..core.event import utc_now
# 时区和 cron 一样是**声明形状**的一部分，所以那两条规则住在 manifest 里，
# 写的时候校验、派发的时候使用，两处 import 的是同一份（`timezone_of` / `cron_matches`）
from ..extensions.manifest import cron_matches, timezone_of
from ..gateway.directory.schedules import ScheduleDirectory

#: 轮询间隔（秒）。**代价是最多晚 30 秒**——换掉了一整套"下一次什么时候醒"的状态。
INTERVAL_SECONDS = 30.0

CREATED = "created"
DISPATCHED = "dispatched"
FAILED = "failed"

SCHEMA = """
CREATE TABLE IF NOT EXISTS dispatches (
    occurrence_key TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    task_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
"""


class Dispatcher(Protocol):
    """派发要的两步。**它是门面的 `TaskDispatch`**——两边共用同一段实现。"""

    def create(self, *, summary: str, executor_ref: str, task_ref: str) -> str: ...

    def start(self, task_id: str) -> None: ...


@dataclass(frozen=True)
class Dispatch:
    occurrence_key: str
    schedule_id: str
    task_id: str = ""
    status: str = CREATED
    detail: str = ""
    updated_at: str = ""

    @property
    def settled(self) -> bool:
        return self.status == DISPATCHED


# ── 派发记录

class DispatchLog:
    """`dispatches` 表。**只有 scheduler 读写它。**"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def get(self, occurrence_key: str) -> Dispatch | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM dispatches WHERE occurrence_key = ?",
                                     (occurrence_key,)).fetchone()
        return _dispatch(row) if row else None

    def save(self, occurrence_key: str, schedule_id: str, *, task_id: str = "",
             status: str = CREATED, detail: str = "") -> Dispatch:
        """**整条覆盖**。两次写的是同一件事的两个阶段，不合并。"""
        record = Dispatch(occurrence_key, schedule_id, task_id, status, detail, utc_now())
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO dispatches (occurrence_key, schedule_id, task_id,"
                " status, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (record.occurrence_key, record.schedule_id, record.task_id,
                 record.status, record.detail, record.updated_at))
            self._conn.commit()
        return record

    def for_schedule(self, schedule_id: str) -> list[Dispatch]:
        """这条日程派出去的那些记录。删日程时靠它找齐它的子 Task。

        **不是"最近"**：那条路上一条都不能漏——漏掉的那些会变成没人认领的 Task。
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM dispatches WHERE schedule_id = ? ORDER BY updated_at",
                (schedule_id,)).fetchall()
        return [_dispatch(row) for row in rows]

    def recent(self, limit: int = 100) -> list[Dispatch]:
        """给前端看的"最近派发过什么"。**只增不减那张表**，所以这里必须限量。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM dispatches ORDER BY updated_at DESC LIMIT ?",
                (int(limit),)).fetchall()
        return [_dispatch(row) for row in rows]

    def prune(self, keep_days: int = 7) -> int:
        """把老的清掉。**"只增不减"是会咬人的**：一条时区写错的日程每天写 1440 条，
        而这个表没有任何自然上限。留几天够回答"昨天晚上跑了吗"。"""
        cutoff = (datetime.now(timezone.utc) - _days(keep_days)).isoformat()
        with self._lock:
            cursor = self._conn.execute("DELETE FROM dispatches WHERE updated_at < ?", (cutoff,))
            self._conn.commit()
        return int(cursor.rowcount or 0)

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def _dispatch(row) -> Dispatch:
    return Dispatch(occurrence_key=row["occurrence_key"], schedule_id=row["schedule_id"],
                    task_id=row["task_id"], status=row["status"], detail=row["detail"],
                    updated_at=row["updated_at"])


# ── 派发

class Scheduler:
    """轮询到点的日程，派发。**它不做定时，也不存日程定义。**"""

    def __init__(self, dispatcher: Dispatcher, schedules: ScheduleDirectory, *,
                 path: str | Path, interval: float = INTERVAL_SECONDS,
                 clock: Any = None) -> None:
        self.dispatcher = dispatcher
        self.schedules = schedules
        self.log = DispatchLog(path)
        self.interval = float(interval)
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()

    # ── 轮询

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, daemon=True, name="occ-scheduler")
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            # **join 要等够**：在飞的那一次派发要么跑完、要么被记成失败，
            # 不能被"2 秒之后就走"丢在半路上（`OPEN_ISSUES.md` 里那条）。
            thread.join(timeout=max(self.interval, 2.0))

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:                      # noqa: BLE001 — 一次坏 tick 不该停掉轮询
                pass
            self._stop.wait(self.interval)

    def tick(self, when: datetime | None = None) -> list[Dispatch]:
        """看一遍有没有到点的。**一条坏日程不影响别的。**"""
        moment = when or self.clock()
        done: list[Dispatch] = []
        self.log.prune()
        for schedule in self.schedules.enabled():
            local = _local_minute(schedule, moment)
            if local is None:
                # 时区写坏了：**也要留痕**，不然这条日程在界面上就是"从来没跑过"。
                _keep(done, self._record_failure(
                    schedule.name, moment.astimezone(timezone.utc),
                    f"时区读不出来: {schedule.timezone!r}"))
                continue
            try:
                if not cron_matches(schedule.cron, local):
                    continue
            except (ValueError, TypeError) as exc:
                _keep(done, self._record_failure(schedule.name, local, f"cron 写坏了: {exc}"))
                continue
            record = self._dispatch(schedule, local)
            if record is not None:
                done.append(record)
        return done

    def task_ids_of(self, name: str) -> list[str]:
        """这条日程派出去的那些 Core Task（删日程时要用，见 `facade._delete_schedule`）。

        **只有这里答得出来**：派发记录归 scheduler，别处要读只能借这个口——
        两处都能翻那张表的话，"一条日程拥有哪些 Task"就会有两个答案。
        """
        return [record.task_id for record in self.log.for_schedule(name) if record.task_id]

    def trigger(self, name: str) -> str:
        """手动跑一次（`schedule.trigger`）。**它和到点派发走同一条路**，
        所以记录、幂等、失败留痕都一样——手动不是特例。"""
        schedule = self.schedules.get(name)
        if schedule is None:
            raise KeyError(f"没有这条日程: {name}")
        local = _local_minute(schedule, self.clock()) or datetime.now(timezone.utc)
        record = self._dispatch(schedule, local, force=True)
        if record is None or not record.task_id:
            raise RuntimeError(f"日程 {name} 这次没有派发成功: {record.detail if record else ''}")
        return record.task_id

    # ── 一次派发：两步，记两次

    def _dispatch(self, schedule, local: datetime, *, force: bool = False) -> Dispatch | None:
        occurrence_key = f"{schedule.name}:{local:%Y-%m-%dT%H:%M}"
        existing = self.log.get(occurrence_key)
        if existing is not None and existing.settled and not force:
            return existing                           # 这一分钟已经派过了
        if not schedule.executor_ref:
            return self._record_failure(schedule.name, local, "这条日程没有写 executor_ref")

        task_id = existing.task_id if existing is not None else ""
        try:
            if not task_id:
                task_id = self.dispatcher.create(
                    summary=schedule.name, executor_ref=schedule.executor_ref,
                    task_ref=schedule.task_ref)
                # **立刻记下来**：这两步之间断了的话，下一个 tick 靠它认出
                # "Task 已经建过了"，只补启动（见文件说明）。
                self.log.save(occurrence_key, schedule.name, task_id=task_id, status=CREATED)
            self.dispatcher.start(task_id)
        except Exception as exc:                      # noqa: BLE001 — 失败要留痕，且不挡别人
            return self._record_failure(schedule.name, local, str(exc), task_id=task_id)
        return self.log.save(occurrence_key, schedule.name, task_id=task_id, status=DISPATCHED)

    def _record_failure(self, name: str, local: datetime, reason: str,
                        task_id: str = "") -> Dispatch | None:
        """落一条 failed，**并把它交回去**（调用方要能说出"这一分钟发生了什么"）。

        这个方法在任何情况下都不许再抛——它本身就在处理失败。
        """
        try:
            key = f"{name}:{local:%Y-%m-%dT%H:%M}"
            existing = self.log.get(key)
            if existing is not None and existing.settled:
                return existing                       # 成功过的那次不能被一次重试改写成失败
            return self.log.save(key, name,
                                 task_id=task_id or (existing.task_id if existing else ""),
                                 status=FAILED, detail=reason)
        except Exception:                             # noqa: BLE001 — 留痕失败也只能算了
            return None


def _keep(records: list[Dispatch], record: Dispatch | None) -> None:
    if record is not None:
        records.append(record)


def _days(count: int) -> timedelta:
    return timedelta(days=int(count))


def _local_minute(schedule, moment: datetime) -> datetime | None:
    """那一刻在这条日程的时区里是几分。**时区写坏了返回 `None`**——由调用方记失败。"""
    try:
        return moment.astimezone(timezone_of(schedule.timezone)).replace(second=0, microsecond=0)
    except Exception:                                 # noqa: BLE001 — 坏时区不是崩溃的理由
        return None
