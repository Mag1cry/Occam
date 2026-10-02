"""控制库 schema：**两张表**，加上把旧库弄成这个形状的迁移。

| 表 | 装什么 |
| --- | --- |
| `tasks` | Task 原语（`core/task.py`） |
| `control_events` | Event Chain 原语（`core/event.py`） |

**两张就是全部**——因为"内核只存两样东西"（`core/README.md`）。
Capability 寄在 Task 的字段和事件链上，Executor 只有一根引用，两个都没有表。

`occ_metadata` 是**第三张，但它不是控制事实**：它只记 schema 自己做过什么
（比如"这条链是某次迁移重建的"）。它不参与判决、不进快照。

## 被删掉的东西

| 删掉 | 为什么 |
| --- | --- |
| `command_results` 表 | 命令缓存整个删了（`core/store.py`）。它当年是"挡重复提交"的第二道门，而第一道门（状态机的前置条件）本来就够 |
| `ix_control_events_task` 索引 | **没有任何查询用它**。事件按 `subject_ref` 读，不按 `task_id` 读——`subject_ref` 是 `task:<id>`，两者本来就是同一个东西 |
| `PRAGMA foreign_keys = ON` | 全库**没有一条外键**，而且它只对执行 `executescript` 的那条连接生效。留着会让人以为有约束 |

## Task 表跟着 Task 走

字段和 `core/task.py` 的 dataclass **一一对应**，改名也一起改
（`executor_config_ref` → `executor_ref`，加 `pending_fingerprint`，
删 `external_runtime_ref` / `attempt` / `idempotency_key` / `request_id`）。

**没有 CHECK 约束**：状态的合法性由 `Task.__post_init__` 判——一处判就够了，
两处判会在某次改动后开始漂移，而且数据库那边报的错是一句没上下文的 `CHECK failed`。
"""
from __future__ import annotations

from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    task_ref TEXT NOT NULL,
    status TEXT NOT NULL,
    executor_ref TEXT NOT NULL,
    session_ref TEXT NOT NULL,
    checkpoint_ref TEXT NOT NULL DEFAULT '',
    state_version INTEGER NOT NULL DEFAULT 0,
    pending_tool_id TEXT NOT NULL DEFAULT '',
    pending_reason_ref TEXT NOT NULL DEFAULT '',
    pending_decision TEXT NOT NULL DEFAULT '',
    pending_fingerprint TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS control_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    subject_ref TEXT NOT NULL,
    task_id TEXT NOT NULL DEFAULT '',
    tool_id TEXT NOT NULL DEFAULT '',
    external_ref TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    checksum TEXT NOT NULL,
    -- 前一条事件的 checksum。空串表示链的起点（genesis）。
    -- 它是「不可篡改」这句话能不能成立的关键：只校验单条时，删掉或重排中间一条
    -- 之后其余每一行依然各自有效，审计链上少了一个控制事实而无人发现。
    prev_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ix_control_events_subject
    ON control_events(subject_ref, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS occ_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# v2：control_events 增加 prev_hash，事件之间连成链。
# v3：删 command_results / 删 task 索引 / Task 表跟着新字段走。
SCHEMA_VERSION = 3

#: 旧 `tasks` 里有、新表不要的列。迁移时删掉。
DROPPED_TASK_COLUMNS = ("external_runtime_ref", "attempt", "idempotency_key", "request_id")

#: 旧 `tasks` 里改过名的列：旧名 → 新名。
RENAMED_TASK_COLUMNS = (("executor_config_ref", "executor_ref"),)

#: 新 `tasks` 里加的列：名字 → 建表片段。
ADDED_TASK_COLUMNS = (("pending_fingerprint", "TEXT NOT NULL DEFAULT ''"),
                      # 归档是 Task 上的一个事实，不是第六个状态（`core/task.py`）
                      ("archived", "INTEGER NOT NULL DEFAULT 0"))


def migrate(conn) -> None:
    """就地升级旧库。**每次打开都会跑，所以必须幂等。**

    判据一律看**表里现在有什么列**，不看版本号——版本号只用来决定要不要跑，
    而列本身才说明"这一步做没做过"。这样中途崩溃、下次打开接着做，不会做重。

    回填 `prev_hash` 是**从当前内容重建链**：它追认不了这之前有没有被动过，
    但能让之后任何篡改可被发现。为了不假装追认过，往 `occ_metadata` 记一笔。

    **而它只在"这一列刚被加上"的那一次做。** 每次打开都重连一遍等于**主动掩盖篡改**——
    删掉中间一条之后，重连会悄悄把链接好，而那正是链存在的理由。

    ## 它不修 `state_version`

    新内核里 `state_version` 恒等于链上的条数（`core/store.py`），但**旧库里不是**——
    旧代码有两条路径改了状态没 bump（直接放行的工具调用、兑现拒绝）。
    迁移**原样保留**那些值：它是一个**计数器**，不是事实；替历史重算一遍等于
    假装当时就是对的。真实那份库里就有（`state_version=2` / 链上 3 条）。

    要不要在迁移时按链的长度重算一遍，是**另外一个决定**——记在 `OPEN_ISSUES.md`。

    ## 它清掉的那一格假引用

    `Task.task_ref` 当年在没给值时回落到调用方的关联 id（`req-<32 位>`）——那不是文件
    路径，只是"没有正文"的另一种写法。**按值的形状清**，所以幂等；清过就在
    `occ_metadata` 里记一笔（那是它存在的理由：一行"什么时候动过数据"）。
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
    if columns:
        for old, new in RENAMED_TASK_COLUMNS:
            if old in columns and new not in columns:
                conn.execute(f"ALTER TABLE tasks RENAME COLUMN {old} TO {new}")
        for name, spec in ADDED_TASK_COLUMNS:
            if name not in columns:
                conn.execute(f"ALTER TABLE tasks ADD COLUMN {name} {spec}")
        for name in DROPPED_TASK_COLUMNS:
            if name in columns:
                conn.execute(f"ALTER TABLE tasks DROP COLUMN {name}")

    event_columns = {row[1] for row in conn.execute("PRAGMA table_info(control_events)")}
    needs_chain_rebuild = bool(event_columns) and "prev_hash" not in event_columns
    if needs_chain_rebuild:
        conn.execute("ALTER TABLE control_events ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''")

    conn.execute("DROP TABLE IF EXISTS command_results")
    conn.execute("DROP INDEX IF EXISTS ix_control_events_task")

    # **清掉旧代码留下的假正文引用。** `task_ref` 当年没给值时回落到调用方的关联 id
    # （`req-<32 位>`），于是库里躺着一串看着像文件路径、其实不是的东西。
    # 按**值的形状**判，所以它天生幂等——清完就没有了，再看一次也什么都不做。
    cleaned = conn.execute(
        "UPDATE tasks SET task_ref = '' "
        "WHERE length(task_ref) = 36 AND substr(task_ref, 1, 4) = 'req-'").rowcount
    if cleaned:
        conn.execute("INSERT INTO occ_metadata(key, value) VALUES('task_ref_cleaned_at', ?) "
                     "ON CONFLICT(key) DO NOTHING", (datetime.now(timezone.utc).isoformat(),))
    # 就地提交：上面那句 UPDATE（**哪怕一行都没改**）会隐式开一个事务，
    # 而下面那段链重建要自己开一个显式事务——"已经在事务里"会让那个 BEGIN 报错。
    conn.commit()

    # **回填只在"这一列刚被加上"的那一次做。** 每次打开都重连一遍等于主动掩盖篡改——
    # 删掉中间一条之后重连会把链接好，而那正是链存在的理由。
    if not needs_chain_rebuild:
        return

    conn.execute("BEGIN")
    try:
        previous = ""
        for row_id, checksum in conn.execute(
            "SELECT rowid, checksum FROM control_events ORDER BY rowid"
        ).fetchall():
            conn.execute("UPDATE control_events SET prev_hash=? WHERE rowid=?", (previous, row_id))
            previous = str(checksum)
        conn.execute(
            "INSERT INTO occ_metadata(key, value) VALUES('event_chain_rebuilt_at', ?) "
            "ON CONFLICT(key) DO NOTHING",
            (datetime.now(timezone.utc).isoformat(),))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
