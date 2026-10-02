"""旧库升上来。

这里造的是**旧的形状**（v1 / v2 的建表语句照抄旧代码），然后拿新代码去开它——
因为真实那份库就在那儿，用户升级时走的就是这条路。

最要紧的一条：**升级不许掩盖被动过的链。**
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from src.core.event import new_event, subject_of, utc_now
from src.core.kernel import Kernel
from src.storage.control import SqliteCoreStore, event_checksum

# ── 旧的形状（照抄迁移前那份代码）

V2_SCHEMA = """
CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, summary TEXT NOT NULL, task_ref TEXT NOT NULL,
    status TEXT NOT NULL, executor_config_ref TEXT NOT NULL,
    external_runtime_ref TEXT NOT NULL DEFAULT '', checkpoint_ref TEXT NOT NULL DEFAULT '',
    attempt INTEGER NOT NULL DEFAULT 1, session_ref TEXT NOT NULL, request_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 0,
    pending_tool_id TEXT NOT NULL DEFAULT '', pending_reason_ref TEXT NOT NULL DEFAULT '',
    pending_decision TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE control_events (
    event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, subject_ref TEXT NOT NULL,
    task_id TEXT NOT NULL DEFAULT '', tool_id TEXT NOT NULL DEFAULT '',
    external_ref TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL, checksum TEXT NOT NULL, prev_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ix_control_events_subject ON control_events(subject_ref, occurred_at, event_id);
CREATE INDEX ix_control_events_task ON control_events(task_id, occurred_at, event_id);
CREATE TABLE command_results (
    idempotency_key TEXT PRIMARY KEY, command_id TEXT NOT NULL,
    request_id TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TABLE occ_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 2;
"""

TASK_ID = "task-旧的"


def _task_row(*, executor_config_ref="localFunction:weather.collect", state_version=2):
    now = utc_now()
    return {"task_id": TASK_ID, "summary": "旧的委托", "task_ref": "inputs/x.md",
            "status": "succeeded", "executor_config_ref": executor_config_ref,
            "external_runtime_ref": "res://旧结果", "checkpoint_ref": "", "attempt": 1,
            "session_ref": "sess-old", "request_id": "req-old", "idempotency_key": "key-old",
            "state_version": state_version, "pending_tool_id": "", "pending_reason_ref": "",
            "pending_decision": "", "created_at": now, "updated_at": now}


def _build_v2(path: Path, *, events: list, task: dict | None = None,
              chained: bool = True) -> None:
    """造一个 v2 形状的库。事件按当时的规矩连成链。"""
    conn = sqlite3.connect(path)
    conn.executescript(V2_SCHEMA)
    previous = ""
    for event in events:
        checksum = event_checksum(event)
        conn.execute(
            "INSERT INTO control_events (event_id,event_type,subject_ref,task_id,tool_id,"
            "external_ref,occurred_at,payload_json,checksum,prev_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (event.event_id, event.event_type, event.subject_ref, event.task_id, event.tool_id,
             event.external_ref, event.occurred_at,
             json.dumps(event.payload, ensure_ascii=False, sort_keys=True,
                        separators=(",", ":")),
             checksum, previous if chained else ""))
        previous = checksum
    if task is not None:
        conn.execute(
            f"INSERT INTO tasks ({','.join(task)}) VALUES ({','.join('?' * len(task))})",
            tuple(task.values()))
    conn.commit()
    conn.close()


def _old_events() -> list:
    subject = subject_of(TASK_ID)
    return [
        new_event("TASK_CREATED", subject, task_id=TASK_ID, payload={"summary": "旧的委托"}),
        new_event("FUNCTION_CALLED", subject, task_id=TASK_ID, tool_id="workspace.read_text",
                  payload={"params_hash": "abc"}),
        new_event("COMPLETED", subject, task_id=TASK_ID, payload={"result_ref": "res://旧结果"}),
    ]


def _metadata(store) -> dict[str, str]:
    conn = sqlite3.connect(store.path)
    try:
        return {row[0]: row[1] for row in conn.execute("SELECT key, value FROM occ_metadata")}
    finally:
        conn.close()


def _tables(store) -> set[str]:
    conn = sqlite3.connect(store.path)
    try:
        return {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    finally:
        conn.close()


def _columns(store, table: str) -> set[str]:
    conn = sqlite3.connect(store.path)
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    finally:
        conn.close()


# ── 升上来

def test_旧库能升上来而历史一条不丢(tmp_path):
    from src.core.kernel import Kernel

    path = tmp_path / "control.sqlite"
    _build_v2(path, events=_old_events(), task=_task_row())

    store = SqliteCoreStore(path)

    assert store.inspect().valid_events == 3
    assert [e.event_type for e in Kernel(store).events(TASK_ID)] == [
        "TASK_CREATED", "FUNCTION_CALLED", "COMPLETED"]


def test_升完之后是新的形状(tmp_path):
    path = tmp_path / "control.sqlite"
    _build_v2(path, events=_old_events(), task=_task_row())

    store = SqliteCoreStore(path)

    assert "command_results" not in _tables(store)
    columns = _columns(store, "tasks")
    assert "executor_ref" in columns
    assert "pending_fingerprint" in columns
    for gone in ("executor_config_ref", "external_runtime_ref", "attempt",
                 "idempotency_key", "request_id"):
        assert gone not in columns


def test_升完之后旧的委托读得出来(tmp_path):
    path = tmp_path / "control.sqlite"
    _build_v2(path, events=_old_events(), task=_task_row())
    store = SqliteCoreStore(path)

    from src.core.kernel import Kernel

    task = Kernel(store).get_task(TASK_ID)

    assert task.status == "succeeded"
    assert task.executor_ref == "localFunction:weather.collect"


def test_升完之后还能接着用(tmp_path):
    path = tmp_path / "control.sqlite"
    _build_v2(path, events=_old_events(), task=_task_row())
    store = SqliteCoreStore(path)

    from src.core.kernel import Kernel
    from src.core.task import CreateTask

    task = Kernel(store).create_task(CreateTask(summary="新的", executor_ref="weather.collect")).task_id

    assert store.inspect().valid_events == 4
    assert task != TASK_ID


# ── 升两次和升一次一样

def test_升级清掉假的正文引用(tmp_path: Path):
    """旧代码把 `req-<关联 id>` 当正文引用写进去过——**那不是文件路径**，
    只是"没有正文"的另一种写法。留着它，快照里就有一格指向不存在的文件。
    """
    path = tmp_path / "control.sqlite"
    task = {**_task_row(), "task_ref": "req-" + "a" * 32}
    _build_v2(path, events=_old_events(), task=task)

    store = SqliteCoreStore(path)

    assert Kernel(store).get_task(TASK_ID).task_ref == ""
    assert "task_ref_cleaned_at" in _metadata(store)


def test_真的正文引用原样留着(tmp_path: Path):
    """只清那一种形状——用户写的路径一个字都不许动。"""
    path = tmp_path / "control.sqlite"
    _build_v2(path, events=_old_events(), task=_task_row())      # task_ref = inputs/x.md

    store = SqliteCoreStore(path)

    assert Kernel(store).get_task(TASK_ID).task_ref == "inputs/x.md"


def test_升级是幂等的(tmp_path):
    path = tmp_path / "control.sqlite"
    _build_v2(path, events=_old_events(), task=_task_row())
    SqliteCoreStore(path).inspect()

    def links(store) -> list[str]:
        conn = sqlite3.connect(store.path)
        try:
            return [str(r[0]) for r in conn.execute(
                "SELECT prev_hash FROM control_events ORDER BY rowid")]
        finally:
            conn.close()

    first = links(SqliteCoreStore(path))
    second = links(SqliteCoreStore(path))

    assert first == second
    assert SqliteCoreStore(path).inspect().valid_events == 3


# ── 最要紧的一条：升级不许掩盖被动过的链

def test_升级不会把被动过的链接回去(tmp_path):
    """**回填只在那一次做。** 每次打开都重连一遍，等于主动掩盖篡改——
    删掉中间一条之后重连会把链接好，而那正是链存在的理由。
    """
    path = tmp_path / "control.sqlite"
    _build_v2(path, events=_old_events(), task=_task_row())
    SqliteCoreStore(path).inspect()             # 先升一次，v2 -> v3

    conn = sqlite3.connect(path)
    middle = conn.execute(
        "SELECT event_id FROM control_events ORDER BY rowid").fetchall()[1][0]
    conn.execute("DELETE FROM control_events WHERE event_id=?", (middle,))
    conn.commit()
    conn.close()

    report = SqliteCoreStore(path).inspect()

    assert report.invalid_events > 0
    assert report.internal_corruption is True


def test_链本来就是断的_打开它就得报(tmp_path):
    path = tmp_path / "control.sqlite"
    _build_v2(path, events=_old_events(), task=_task_row(), chained=False)

    report = SqliteCoreStore(path).inspect()

    assert report.invalid_events > 0


# ── v1（还没有链的年代）

V1_SCHEMA = V2_SCHEMA.replace(
    "checksum TEXT NOT NULL, prev_hash TEXT NOT NULL DEFAULT ''",
    "checksum TEXT NOT NULL").replace("PRAGMA user_version = 2;", "PRAGMA user_version = 1;")


def test_更旧的库也能升上来_并且老实记一笔(tmp_path):
    """v1 没有链可保——回填是**从当前内容重建**，它追认不了之前有没有被动过。
    为了不假装追认过，往 `occ_metadata` 记一笔。
    """
    path = tmp_path / "control.sqlite"
    conn = sqlite3.connect(path)
    conn.executescript(V1_SCHEMA)
    for event in _old_events():
        conn.execute(
            "INSERT INTO control_events (event_id,event_type,subject_ref,task_id,tool_id,"
            "external_ref,occurred_at,payload_json,checksum) VALUES (?,?,?,?,?,?,?,?,?)",
            (event.event_id, event.event_type, event.subject_ref, event.task_id, event.tool_id,
             event.external_ref, event.occurred_at,
             json.dumps(event.payload, ensure_ascii=False, sort_keys=True,
                        separators=(",", ":")),
             event_checksum(event)))
    conn.commit()
    conn.close()

    store = SqliteCoreStore(path)
    report = store.inspect()

    conn = sqlite3.connect(path)
    try:
        rows = conn.execute(
            "SELECT value FROM occ_metadata WHERE key='event_chain_rebuilt_at'").fetchall()
    finally:
        conn.close()
    assert rows, "重建过就该留一笔"
    assert report.valid_events == 3
