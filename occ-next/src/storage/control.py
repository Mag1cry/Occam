"""SQLite 实现：事件链 checksum + prev_hash、损坏检测、尾部修复。

它是 `core/kernel.py` 的 `CoreStore` 的**唯一实现**，也是内核唯一允许做 IO 的地方——
`core/` 的章程头一句就是"不运行、不做 IO"，所以真正落盘的那一份必须住在外面。

## 链怎么连、怎么验

**写**：追加时取**上一行存储的** checksum 当自己的 `prev_hash`。
**验**：拿**上一行按内容重算的** checksum 去比。

这个不对称是**故意的**：如果验的时候也读存储值，"只改了某一条的 checksum 列"
就会连带把它后面每一行都判成坏的——一条的错变成一片的错，而真正的坏只有那一行。

`event_checksum` 覆盖**内容字段**，不含 `prev_hash`、不含位置。
所以"重排也能被发现"靠的是**链接比对**，不是哈希本身——两样都要有。

## 两种坏法，处置不同

| 坏法 | 判断依据 | 处置 |
| --- | --- | --- |
| **尾部撕了一角** | 只有最后一行失败，**而且失败原因是它自己内容坏了** | 可以截断（要有备份 + 显式确认） |
| **中间被动过** | 链断了（`prev_hash` 接不上），或中间某行内容坏了 | **不可截断** |

两条限定都不能少：光看位置，中间某条被改会让它之后的每一行都失败，会被误判成尾巴；
光看"哪一行失败"，删掉中间一条后剩下的最后一行恰好也会在链上失败。

## 那道"写而不记事件"的绊线

`transaction()` 提交后，只有**写过事件**或**一行都没改**才推进 `_last_data_version`。
否则下一次任意访问会做一次全链重验（O(N)）。

它是 ADR-019 在存储层的兜底：**改了状态却没记事件，这里会当场发现。**
代价要认——N 大了之后它是一颗性能地雷。今天**它正在报警**（旧代码的兑现拒绝、
重复批准两条路径都没记事件），新内核把这两条都堵住了（`core/capability.py` 规则三）。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, Iterator

from ..core.errors import EventStoreCorrupted
from ..core.event import ControlEvent, StoredEvent, utc_now
from ..core.kernel import CoreUnitOfWork
from ..core.task import Task

from .schema import SCHEMA, SCHEMA_VERSION, migrate

#: `tasks` 表的列，顺序和 `Task` 的字段一一对应。
TASK_COLUMNS = (
    "task_id", "summary", "task_ref", "status", "executor_ref", "session_ref",
    "checkpoint_ref", "state_version", "pending_tool_id", "pending_reason_ref",
    "pending_decision", "pending_fingerprint", "created_at", "updated_at",
    "archived",
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _event_body(event: ControlEvent) -> dict[str, Any]:
    return {"event_id": event.event_id, "event_type": event.event_type,
            "subject_ref": event.subject_ref, "task_id": event.task_id,
            "tool_id": event.tool_id, "external_ref": event.external_ref,
            "occurred_at": event.occurred_at, "payload": event.payload}


def event_checksum(event: ControlEvent) -> str:
    """一条事件的指纹。**不含 `prev_hash`、不含位置**——见文件头那段不对称。"""
    return hashlib.sha256(_json(_event_body(event)).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class RecoveryReport:
    """一次全表校验的结论。**它不是控制事实**，所以不落库、不进链。"""

    valid_events: int
    invalid_events: int
    tail_corruption: bool
    internal_corruption: bool
    errors: tuple[str, ...] = ()
    backup_path: str = ""
    removed_event_ids: tuple[str, ...] = ()
    repaired: bool = False


class _ChainLinkBroken(EventStoreCorrupted):
    """这一行的内容没坏，但它接不上前一条——前面少了或换了一条。

    和「这一行自己坏了」要分开：前者意味着中间被动过，后者在最后一行时是无歧义的撕尾。
    """


class SqliteCoreStore:
    """`CoreStore` 的实现。**每次事务一条新连接**——SQLite 的连接很便宜，
    而常驻一条连接要自己管失效、管重连，换不来什么。
    """

    def __init__(self, path: str | Path, *, on_fact: Any = None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._validate_database_version()
        self._lock = RLock()
        # `_monitor` 是**只为 `PRAGMA data_version` 存在**的一条独立连接：
        # 别的连接提交过，这个数就会变，于是知道"该重验了"。
        self._monitor = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        self._blocked = False
        # **事实落链之后叫一声。** 耳朵是别人递进来的（装配期给，见 `app/build.py`）——
        # 存储自己不 import 任何人、不认识审计、也不认识输出层，它只多一句
        # "如果有耳朵，说一声"。
        self._on_fact = on_fact
        self._last_data_version = self._data_version()
        self.initialize()
        self._last_data_version = self._data_version()

    # ── 打开与迁移

    def _validate_database_version(self) -> None:
        """拒绝比本代码**更新**的库；更旧的留给 `migrate()` 升。

        原来这里是 `version != SCHEMA_VERSION`：那样一 bump 就把所有现存库锁死，
        迁移代码永远走不到。
        """
        if not self.path.exists() or self.path.stat().st_size == 0:
            return
        conn = sqlite3.connect(self.path, timeout=30)
        try:
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        finally:
            conn.close()
        if tables and version > SCHEMA_VERSION:
            raise EventStoreCorrupted(
                f"数据库版本 {version} 比本代码支持的 {SCHEMA_VERSION} 更新；请升级 OCC")

    def initialize(self) -> None:
        with self._lock:
            conn = sqlite3.connect(self.path, timeout=30)
            try:
                conn.executescript(SCHEMA)
                migrate(conn)
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                conn.commit()
            finally:
                conn.close()

    # ── 事务

    def _data_version(self) -> int:
        return int(self._monitor.execute("PRAGMA data_version").fetchone()[0])

    def _refresh_integrity(self) -> None:
        if self._blocked:
            raise EventStoreCorrupted("控制事件存储已损坏，追加已阻断")
        current = self._data_version()
        if current == self._last_data_version:
            return
        report = self._inspect_connection()
        self._last_data_version = current
        if report.invalid_events:
            self._blocked = True
            raise EventStoreCorrupted("控制事件存储完整性校验失败: " + "; ".join(report.errors))

    def _inspect_connection(self) -> RecoveryReport:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            return SqliteUnitOfWork(conn).recover()
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[SqliteUnitOfWork]:
        with self._lock:
            self._refresh_integrity()
            conn = sqlite3.connect(self.path, timeout=30)
            conn.row_factory = sqlite3.Row
            facts: list[Any] = []
            try:
                conn.execute("BEGIN IMMEDIATE")
                before_changes = conn.total_changes
                uow = SqliteUnitOfWork(conn, facts=facts)
                yield uow
                conn.commit()
                # 一次正常的迁移会追加事件。**改了行却没记事件就别推进记号**——
                # 下一次访问会强制全链重验，那就是绊线在响（见文件头）。
                if uow.event_written or conn.total_changes == before_changes:
                    self._last_data_version = self._data_version()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
            # **提交成功了才叫。** 上面那个 `raise` 已经把回滚那条路走掉了，
            # 所以走到这儿的每一个事实都是**落库了的**。
            self._announce(facts)

    def _announce(self, facts: list[Any]) -> None:
        """事实落链之后，叫一声。

        **叫一声不等于把活干了**：耳朵只许放下一个标记或入队，真正的活（写流水、
        生成输出、发卡片）由听见的人自己安排——否则一次慢 IO 会把数据库锁握在手里，
        而"内核不调度线程"那条就成了空话。

        **叫不动不是失败。** 这一刻事实已经落库了，把这儿的一次异常变成"命令失败"，
        会让调用方以为什么都没发生——而它已经发生了。那是这个仓库最不能出现的那类假话。
        所以只报告，不往上抛。
        """
        if self._on_fact is None:
            return
        for fact in facts:
            try:
                self._on_fact(fact)
            except Exception as exc:            # noqa: BLE001 — 见上
                print(f"[事实] 叫一声失败（不影响已落库的事实）: {exc}", file=sys.stderr)

    @contextmanager
    def read_transaction(self) -> Iterator[SqliteUnitOfWork]:
        with self._lock:
            self._refresh_integrity()
            conn = sqlite3.connect(self.path, timeout=30)
            conn.row_factory = sqlite3.Row
            try:
                # 延迟事务：读者拿到一致快照，但不占 SQLite 的 RESERVED 写锁。
                conn.execute("BEGIN")
                yield SqliteUnitOfWork(conn)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    # ── 维护口（**不在内核，也不在 HTTP**）

    def close(self) -> None:
        """关掉那条监测连接。**事务的连接本来就是每次新开的**，所以只剩这一条要收。

        关停时不收它，进程退出前会一直挂着一个 sqlite 句柄——测试里那是"文件删不掉"，
        线上那是"备份工具说这个库正被占用"。
        """
        with self._lock:
            self._monitor.close()

    def recover(self) -> RecoveryReport:
        """启动时跑一次：判"这个库还能不能信"。**它自己不抛**——
        是之后第一次访问才抛（`_refresh_integrity`）。"""
        with self._lock:
            report = self._inspect_connection()
            self._blocked = bool(report.invalid_events)
            self._last_data_version = self._data_version()
            return report

    def inspect(self) -> RecoveryReport:
        """看一眼，不动数据。"""
        return self.recover()

    def repair_tail(self, expected_event_ids: list[str], confirm: bool) -> RecoveryReport:
        """截断一个**被显式确认过的**物理尾巴。

        要 `confirm`、要精确列出待删的 event_id、先备份——三样缺一不可，
        因为它删的是"不可删的事实"。
        """
        if not confirm:
            return self.inspect()
        with self._lock:
            report = self._inspect_connection()
            if not report.tail_corruption or report.internal_corruption:
                raise EventStoreCorrupted("只有已确认的尾部损坏可以修复")
            conn = sqlite3.connect(self.path, timeout=30)
            conn.row_factory = sqlite3.Row
            try:
                rows = conn.execute("SELECT event_id FROM control_events ORDER BY rowid").fetchall()
            finally:
                conn.close()
            actual_tail = ([str(row["event_id"]) for row in rows[-report.invalid_events:]]
                           if report.invalid_events else [])
            if actual_tail != list(expected_event_ids):
                raise EventStoreCorrupted("待修复的事件尾部与确认列表不一致")
            # 备份名带时间戳：固定名字会让**第二次修复静默覆盖第一次的备份**，
            # 而第一次那份往往才是"出事之前"的样子。
            backup = self.path.with_name(
                f"{self.path.name}.{utc_now().replace(':', '')}.backup")
            source = sqlite3.connect(self.path)
            target = sqlite3.connect(backup)
            try:
                source.backup(target)
            finally:
                target.close()
                source.close()
            conn = sqlite3.connect(self.path, timeout=30)
            try:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(
                    "DELETE FROM control_events WHERE rowid IN "
                    "(SELECT rowid FROM control_events ORDER BY rowid DESC LIMIT ?)",
                    (report.invalid_events,))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
            self._blocked = False
            self._last_data_version = self._data_version()
            remaining = self._inspect_connection()
            return RecoveryReport(valid_events=report.valid_events, invalid_events=0,
                                  tail_corruption=False, internal_corruption=False,
                                  errors=remaining.errors, backup_path=str(backup),
                                  removed_event_ids=tuple(actual_tail), repaired=True)

    def append(self, event: ControlEvent) -> StoredEvent:
        """裸追加。**只有维护和测试用**——正常路径都是走命令里的 `commit()`。"""
        with self.transaction() as uow:
            return uow.append_event(event)


class SqliteUnitOfWork(CoreUnitOfWork):
    """一次事务。**Task + 事件，两张表，没有第三张。**"""

    def __init__(self, conn: sqlite3.Connection, *, facts: list[Any] | None = None) -> None:
        self.conn = conn
        self.event_written = False
        #: 这一趟事务里落链的事件。**提交成功之后**才由 store 交给耳朵
        #: （回滚的那条路上它们谁也不该听见）。
        self.facts = facts if facts is not None else []

    # ── TaskStore

    def get_task(self, task_id: str) -> Task | None:
        row = self.conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        return Task(**dict(row)) if row else None

    def list_tasks(self) -> list[Task]:
        rows = self.conn.execute("SELECT * FROM tasks ORDER BY updated_at DESC, task_id").fetchall()
        return [Task(**dict(row)) for row in rows]

    def save_task(self, task: Task) -> None:
        columns = ", ".join(TASK_COLUMNS)
        placeholders = ", ".join("?" * len(TASK_COLUMNS))
        updates = ", ".join(f"{name}=excluded.{name}" for name in TASK_COLUMNS if name != "task_id")
        self.conn.execute(
            f"INSERT INTO tasks ({columns}) VALUES ({placeholders}) "
            f"ON CONFLICT(task_id) DO UPDATE SET {updates}",
            tuple(getattr(task, name) for name in TASK_COLUMNS))

    def delete_task(self, task_id: str) -> None:
        """删掉 Task 那一行。**事件一条都不动**（见 `core/task.py::Forget`）。"""
        self.conn.execute("DELETE FROM tasks WHERE task_id=?", (task_id,))

    # ── EventStore

    def append_event(self, event: ControlEvent) -> StoredEvent:
        checksum = event_checksum(event)
        # 前一条的 checksum 就是这条的 prev_hash。读与写在同一个 BEGIN IMMEDIATE
        # 事务里，所以没有并发插入能插到中间。
        row = self.conn.execute(
            "SELECT checksum FROM control_events ORDER BY rowid DESC LIMIT 1").fetchone()
        prev_hash = str(row[0]) if row else ""
        try:
            self.conn.execute(
                """INSERT INTO control_events
                   (event_id,event_type,subject_ref,task_id,tool_id,external_ref,
                    occurred_at,payload_json,checksum,prev_hash)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (event.event_id, event.event_type, event.subject_ref, event.task_id,
                 event.tool_id, event.external_ref, event.occurred_at,
                 _json(event.payload), checksum, prev_hash))
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"控制事件已存在或无法追加: {event.event_id}") from exc
        self.event_written = True
        self.facts.append(event)
        return StoredEvent(event, checksum)

    def load_subject_chain(self, subject_ref: str) -> list[StoredEvent]:
        """按 subject 过滤的读，**不是**链校验——见 `core/event.py` 的 `chain_of`。"""
        rows = self.conn.execute(
            "SELECT * FROM control_events WHERE subject_ref=? ORDER BY rowid",
            (subject_ref,)).fetchall()
        return [self._stored_from_row(row) for row in rows]

    # ── 校验

    def recover(self) -> RecoveryReport:
        rows = self.conn.execute("SELECT * FROM control_events ORDER BY rowid").fetchall()
        errors: list[str] = []
        invalid_indices: list[int] = []
        expected_prev: str | None = None
        broken_at: int | None = None
        link_break = False
        for index, row in enumerate(rows):
            try:
                stored = self._stored_from_row(row, expected_prev)
            except Exception as exc:
                invalid_indices.append(index)
                errors.append(f"event {row['event_id']}: {exc}")
                link_break = isinstance(exc, _ChainLinkBroken)
                # 链一断，后面每一行都**无法证明**自己接得上：不是"已知坏"，
                # 而是"证不了"。两者都按不可信计，但不再重复报同一个原因。
                broken_at = index
                break
            expected_prev = stored.checksum
        if broken_at is not None:
            invalid_indices.extend(range(broken_at + 1, len(rows)))
        tail = (invalid_indices == [len(rows) - 1] and not link_break and bool(rows))
        internal = bool(invalid_indices) and not tail
        return RecoveryReport(valid_events=len(rows) - len(invalid_indices),
                              invalid_events=len(invalid_indices),
                              tail_corruption=tail, internal_corruption=internal,
                              errors=tuple(errors))

    @staticmethod
    def _stored_from_row(row: sqlite3.Row, expected_prev: str | None = None) -> StoredEvent:
        """校验一行：自身 checksum + 与前一条的链接。

        `expected_prev` 是**上一条按内容算出来的** checksum（`None` 表示不校验链接，
        比如按 subject 过滤读子集时）。
        """
        event = ControlEvent(event_id=row["event_id"], event_type=row["event_type"],
                             subject_ref=row["subject_ref"], task_id=row["task_id"],
                             tool_id=row["tool_id"], external_ref=row["external_ref"],
                             occurred_at=row["occurred_at"],
                             payload=json.loads(row["payload_json"]))
        checksum = event_checksum(event)
        if checksum != row["checksum"]:
            raise EventStoreCorrupted(f"checksum 不匹配: {event.event_id}")
        if expected_prev is not None and str(row["prev_hash"]) != expected_prev:
            raise _ChainLinkBroken(f"事件链断裂: {event.event_id} 的前序哈希与上一条不匹配")
        return StoredEvent(event, checksum)
