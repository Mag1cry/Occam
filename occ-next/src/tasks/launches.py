"""Worker 启动记录——**对账的依据，不是观测**。

一行一次启动：`launch_id` · `task_id` · `executor_ref` · `process_id` · `started_at` ·
`ended_at` · `status` · `report_kind` · `diagnostic`。

## 它为什么该落库，而别的观测不该

"**不落观测**"那条（ADR-028）说的是：别把"它现在是活的"写进库里——崩溃之后那句话就是假的。
但这里存的**不是现在的状态，是当时发生过的事**：

| 存什么 | 之后还能不能说真话 |
| --- | --- |
| `online: true` | ✗ 崩溃之后是假话 |
| "3 点 12 分起过一个进程，pid 是 4812" | ✓ 它永远是真的 |

所以 `reconcile.py` 能在重启之后拿它去探 pid。**这就是它存在的全部理由。**

## 谁读写

`controller.py` 写（开一次、收一次），`reconcile.py` 读（重启之后看哪些还开着）。
**两个读者 → 单独立一个文件**（对比：`dispatches` 只有 `scheduler.py` 读写，就住在那边）。

## 顺带删掉的：`controller_runs`

旧代码里有两张表，另一张记的是**控制器自己的启停**。它的唯一读者是诊断——而"诊断不落库"
那条已经裁过了。**删掉。**

← 来自 control/lifecycle.py（`controller_runs` 已删）
"""
from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from ..core.event import utc_now

SCHEMA = """
CREATE TABLE IF NOT EXISTS worker_launches (
    launch_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    executor_ref TEXT NOT NULL,
    process_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    report_kind TEXT NOT NULL DEFAULT '',
    diagnostic TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_worker_launches_task ON worker_launches (task_id);
"""

RUNNING = "running"
DONE = "done"


@dataclass(frozen=True)
class Launch:
    launch_id: str
    task_id: str
    executor_ref: str
    process_id: int
    started_at: str
    ended_at: str = ""
    status: str = RUNNING
    report_kind: str = ""
    diagnostic: str = ""


class LaunchLog:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    # ── 写

    def open(self, *, task_id: str, executor_ref: str, process_id: int) -> Launch:
        """**起之前先记下来。** 反过来（起完再记）会在两者之间留一个窗口：
        进程活着、而没有任何一行说它存在——那正是重启对账看不见的那种。"""
        launch = Launch(launch_id=f"launch-{uuid4().hex}", task_id=task_id,
                        executor_ref=executor_ref, process_id=int(process_id),
                        started_at=utc_now())
        with self._lock:
            self._conn.execute(
                "INSERT INTO worker_launches (launch_id, task_id, executor_ref, process_id,"
                " started_at, status) VALUES (?, ?, ?, ?, ?, ?)",
                (launch.launch_id, launch.task_id, launch.executor_ref,
                 launch.process_id, launch.started_at, RUNNING))
            self._conn.commit()
        return launch

    def close(self, launch_id: str, *, report_kind: str = "", diagnostic: str = "") -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE worker_launches SET ended_at = ?, status = ?, report_kind = ?,"
                " diagnostic = ? WHERE launch_id = ?",
                (utc_now(), DONE, report_kind, diagnostic, launch_id))
            self._conn.commit()

    # ── 读

    def open_launches(self) -> list[Launch]:
        """还开着的那些。**重启之后，这就是"可能还在跑的进程"的完整清单。**"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM worker_launches WHERE status = ? ORDER BY started_at",
                (RUNNING,)).fetchall()
        return [_launch(row) for row in rows]

    def open_for(self, task_id: str) -> Launch | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM worker_launches WHERE task_id = ? AND status = ?"
                " ORDER BY started_at DESC LIMIT 1", (task_id, RUNNING)).fetchone()
        return _launch(row) if row else None

    def last_for(self, task_id: str) -> Launch | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM worker_launches WHERE task_id = ?"
                " ORDER BY started_at DESC LIMIT 1", (task_id,)).fetchone()
        return _launch(row) if row else None

    def database_close(self) -> None:
        with self._lock:
            self._conn.close()


def _launch(row) -> Launch:
    return Launch(
        launch_id=row["launch_id"], task_id=row["task_id"], executor_ref=row["executor_ref"],
        process_id=int(row["process_id"]), started_at=row["started_at"],
        ended_at=row["ended_at"], status=row["status"],
        report_kind=row["report_kind"], diagnostic=row["diagnostic"])
