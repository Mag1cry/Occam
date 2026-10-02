"""结果和审计的查询口：**结果归执行者的包**（内核只存 `result_ref`，ADR-008）。

`extensions/executors.py::open_adapter` 在 `worker.py` 旁边看到它就自动认。要的三格：

| 方法 | 答什么 |
| --- | --- |
| `checkpoint_exists` | 这个引用还在一份真的存下来的状态上吗（**必须有**）|
| `read_result` | 这个 Task 最后那段话（**必须有**）|
| `read_audit` | 模型这一路说了什么、要了哪些工具、判定是什么（**可选，这里提供**）|

三个都是**纯读**，不参与启动。读的是 `graph.py` 那本账（同一份形状，`Journal` 一处定义），
所以这一层**不装 langchain 也读得动**——它读的是我们自己存的那种字典。

## 顺手修掉的两笔账

- **`config` 收下就丢**：它现在是这一层的**身份**。审计里那句"这份记录是哪个模型跑的"
  就来自 `config["model"]`——同一个执行者可以被好几条配置用，光看那个库文件名看不出来。
- **`database_path` 传两遍**：`get_adapter(config, database_path)` 给一份，每个方法又各给
  一份。旧代码两处都收、只有一处用；这里**两处都认**：构造函数收的那份是兜底，
  方法参数才是现场那一份（方法参数优先）。

## 读不到就是读不到

不返回空数组冒充"没有调用"（旧实现的那句话）：`available: false` 外加一句原因。
调用方（`web/http.py`）把它原样交给前端，前端不必自己分辨"空"和"没有"。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .graph import Journal, thread_of


def get_adapter(config: dict[str, Any], database_path: str) -> "LangGraphAgentAdapter":
    """宿主取 adapter 的那一步。**它不 import 任何重东西**——读结果不该拉起一个模型库。"""
    return LangGraphAgentAdapter(config, database_path)


class LangGraphAgentAdapter:
    def __init__(self, config: dict[str, Any], database_path: str) -> None:
        self.config = dict(config or {})
        self.database_path = str(database_path)

    # ── 必须有的两个

    def checkpoint_exists(self, task: Any, checkpoint_ref: str, database_path: str = "") -> bool:
        """这个引用还指着一份存下来的状态吗。**对不上这条线程就算没有**——
        checkpoint 是"从那一把继续"，不是"跳到另一把"。"""
        saved = Journal(self._path(database_path)).checkpoint(str(checkpoint_ref))
        return bool(saved) and saved["thread"] == self._thread(task)

    def read_result(self, task: Any, database_path: str = "") -> dict[str, Any]:
        """这个 Task 的结果。**按（线程，Task）两个键找**——session 是共享的线程，
        里面可能跑过好几轮，"最新那份"不等于"这次那份"。

        `ok` 说的是"这一份能用"：停在等审批或者没跑完的那几轮，`text` 是空的、
        `reason` 说清它停在哪儿。**不编一个空结果冒充跑完了。**
        """
        stored = Journal(self._path(database_path)).run(self._thread(task), str(task.task_id))
        if stored is None:
            return {"ok": False, "text": "",
                    "reason": "执行者这里没有这个 Task 的记录（没跑过，或者那个文件已经不在了）"}
        result: dict[str, Any] = {
            "ok": stored["status"] == "completed", "text": stored["result"],
            "status": stored["status"], "steps": stored["step"],
            "task_id": stored["task_id"], "session_ref": stored["thread"],
            "updated_at": stored["updated_at"],
        }
        if not result["ok"]:
            result["reason"] = (f"这一轮是 {stored['status']}，没有最后那段话"
                                f"（等审批或者没跑完的轮次都在这儿）")
        return result

    # ── 可选的那一个

    def read_audit(self, task: Any, database_path: str = "") -> dict[str, Any]:
        """模型这一路说了什么（前端那个面板看的就是它）。

        调用是**折出来**的：一次调用一条记录，顺序就是消息顺序，标识用模型给的那个
        `tool_call_id`。状态只由"有没有对应的工具应答"决定——不从参数或返回内容里猜，
        那会把审计变成推演。
        """
        projection: dict[str, Any] = {
            "available": False,
            "source": "langgraph-agent/sqlite",
            "read_at": datetime.now(timezone.utc).isoformat(),
            "model": str(dict(self.config.get("model") or {}).get("model") or ""),
            "provider": str(dict(self.config.get("model") or {}).get("provider") or ""),
            "calls": [],
            "turns": [],
        }
        stored = Journal(self._path(database_path)).run(self._thread(task), str(task.task_id))
        if stored is None:
            projection["reason"] = "执行者这里没有这个 Task 的记录"
            return projection
        rows = stored["messages"]
        projection.update({"available": True, "status": stored["status"],
                           "steps": stored["step"], "updated_at": stored["updated_at"],
                           "calls": tool_calls_of(rows), "turns": turns_of(rows)})
        return projection

    # ── 库路径和线程名：**构造函数收的那一份和方法参数那一份在这儿对上**

    def _path(self, database_path: str) -> Path:
        return Path(database_path or self.database_path)

    def _thread(self, task: Any) -> str:
        return thread_of(str(getattr(task, "session_ref", "") or ""),
                         str(getattr(task, "task_id", "") or ""))


# ── 消息 → 审计投影（纯函数，形状跟 `graph.py` 存的那种字典走）

def tool_calls_of(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """折成「一次调用 = 一条记录」。"""
    answers: dict[str, dict[str, Any]] = {
        str(row.get("tool_call_id")): row for row in rows
        if row.get("role") == "tool" and row.get("tool_call_id")
    }
    calls: list[dict[str, Any]] = []
    for row in rows:
        for call in row.get("tool_calls") or []:
            call_id = str(call.get("id") or "")
            answer = answers.get(call_id)
            calls.append({
                "call_id": call_id or f"call-{len(calls) + 1}",
                "tool_id": str(call.get("tool_id") or call.get("name") or ""),
                "args": dict(call.get("args") or {}),
                "status": _status_of(answer),
                "result": _result_of(answer),
            })
    return calls


def turns_of(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """谁说了什么，**按顺序**——这是 checkpoint 里那一串的直译。

    `ai` 那一轮还要带上**它要调的那些工具**（名字 + 参数）：不带的话，消息序列里
    只看得到"模型说了一句话"，看不到"所以它接下来要干什么"——而中间那一环恰恰
    是审计最要看的东西。

    结果不进这里（它在 `calls` 那一份里，按 `call_id` 对得上）：这里说的是
    **谁说了什么**，不是"那次调用最后怎么了"。
    """
    turns: list[dict[str, Any]] = []
    for row in rows:
        role = str(row.get("role") or "")
        if role not in ("system", "human", "ai", "tool"):
            continue
        turn: dict[str, Any] = {"role": role, "text": str(row.get("text") or ""),
                                "tool_id": str(row.get("tool_id") or ""),
                                "status": str(row.get("status") or "")}
        if role == "ai":
            turn["calls"] = [{"call_id": str(call.get("id") or ""),
                              "tool_id": str(call.get("tool_id") or call.get("name") or ""),
                              "args": dict(call.get("args") or {})}
                             for call in (row.get("tool_calls") or [])]
        turns.append(turn)
    return turns


def _status_of(answer: dict[str, Any] | None) -> str:
    if answer is None:
        return "pending"
    return "failed" if str(answer.get("status") or "") == "error" else "completed"


def _result_of(answer: dict[str, Any] | None) -> Any:
    if answer is None:
        return None
    text = str(answer.get("text") or "")
    try:
        return json.loads(text)
    except ValueError:
        return text          # 工具结果本来就可能是句人话，不是 JSON
