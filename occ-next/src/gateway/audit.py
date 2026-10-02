"""审计流水与事实流游标。

| 表 | 装什么 | 谁读 |
| --- | --- | --- |
| `gateway_events` | 网关见过的命令：谁、什么时候、什么结果、**谁脏了** | 审计 + SSE 事实流 |

## 边界

- **不是内核的事实**。内核的事实（Task、控制事件）在 `storage/`。这里的记录**回答不了**
  "委托处于什么状态"，只回答"网关见过哪些请求"。
- **不推派生结果**。事实流只标记"哪些对象脏了"，状态一律来自重读（ADR-031）——
  两侧各算一遍就是漂移的来源。
- **不存观测**。以前这里还有 `abilities` / `gateway_capabilities` 两张表，把能力登记处的
  在线状态落了库——**而且没有任何生产消费者**。那两张表已删：把观测落库、还落了一份
  没人看的，是 ADR-028 明令禁止的那件事。
- **没有游标表**。游标就是客户端拿着的那个序号（`after(cursor)` 读它之后的），
  服务端再存一份位置，就得回答"谁的位置才算数"。以前那张 `gateway_cursor` 零读者，
  删了。

**表就在这一层，不跟内核的两张混**：它们回答的是不同的问题，混在一张库里迟早会有人
拿它当控制事实用。

← 来自 gateway_store.py（abilities / gateway_capabilities / gateway_cursor 已删）
"""
from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..core.event import utc_now

SCHEMA = """
CREATE TABLE IF NOT EXISTS gateway_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    principal TEXT NOT NULL,
    outcome TEXT NOT NULL,
    subject_ref TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
);
"""


@dataclass(frozen=True)
class GatewayEvent:
    """网关见过的一条。`subject_ref` 说的是**谁脏了**——事实流靠它说话。"""

    seq: int
    command: str
    principal: str
    outcome: str
    subject_ref: str = ""
    detail: str = ""
    occurred_at: str = ""
    payload: dict[str, Any] = field(default_factory=dict)


class AuditLog:
    """一条追加流水。**没有更新、没有删除**——它是记录，不是状态。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def record(self, *, command: str, principal: str, outcome: str,
               subject_ref: str = "", detail: str = "",
               payload: dict[str, Any] | None = None) -> GatewayEvent:
        """记一条。**返回它自己**——调用方要用它的 `seq` 当游标。"""
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO gateway_events (command, principal, outcome, subject_ref,"
                " detail, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (command, principal, outcome, subject_ref, detail, utc_now(),
                 json.dumps(payload or {}, ensure_ascii=False)),
            )
            self._conn.commit()
            return self._row(cursor.lastrowid)

    def fact(self, event: Any) -> None:
        """把**一条内核事实**记进流水。

        ## 它和 `record()` 的差别只有一个字：谁做的

        | | 谁做的 | 例子 |
        | --- | --- | --- |
        | `record()` | **调用方**（带 principal、判定、载荷） | `web:local@127.0.0.1 提交了 cancel` |
        | `fact()` | **内核自己** | `INTERRUPTED` —— worker 停下来等审批 |

        ## 为什么非有它不可

        事实流读的就是这张表，而**今天只有 `facade.submit` 往里写**——于是它只看得见
        **命令面**。worker 那条路（请求审批、跑完、失败）走的是
        `tasks/controller.py` → `pipeline.py` → `core/kernel.py`，**根本不经过门面**。
        结果：**"有人要审批"这件事，界面要等下一次重读才知道**——而它自称"实时"。

        这条路的写者是**内核**：`storage/control.py` 在事务提交成功之后叫一声
        （`on_fact`，装配期递进来的耳朵），这一格把那个声音记下来。

        `principal="kernel"`：这张表里唯一一个不是"某个人"的主体。
        """
        self.record(command=event.event_type, principal="kernel", outcome="ok",
                    subject_ref=f"task:{event.task_id}", detail=str(event.tool_id or ""))

    def after(self, cursor: int, limit: int = 200) -> list[GatewayEvent]:
        """游标之后的事件。**只标记脏，不带状态**（ADR-031）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM gateway_events WHERE seq > ? ORDER BY seq LIMIT ?",
                (int(cursor), int(limit)),
            ).fetchall()
        return [self._event(row) for row in rows]

    def latest(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COALESCE(MAX(seq), 0) AS seq FROM gateway_events").fetchone()
        return int(row["seq"])

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ── 行 ↔ 对象

    def _row(self, seq: int | None) -> GatewayEvent:
        with self._lock:
            row = self._conn.execute("SELECT * FROM gateway_events WHERE seq = ?",
                                     (int(seq or 0),)).fetchone()
        return self._event(row)

    @staticmethod
    def _event(row) -> GatewayEvent:
        payload = json.loads(row["payload"] or "{}")
        return GatewayEvent(
            seq=int(row["seq"]), command=row["command"], principal=row["principal"],
            outcome=row["outcome"], subject_ref=row["subject_ref"], detail=row["detail"],
            occurred_at=row["occurred_at"],
            payload=payload if isinstance(payload, dict) else {},
        )
