"""**契约四的落点**：ReAct 循环 + 绑 schema 字典 + 工具一律走管道。

这段代码手里**什么都没有**：模型吐的是"名字 + 参数"，它把那个名字和参数原样交给
`channel.request_tool`，判决和执行都在网关那一侧。绑给模型的是 schema 字典
（`tasks/channel.py` 契约四）——**框架手里根本没有能跑的东西**，所以
`create_agent` / `create_react_agent` / `ToolNode` 一个都不能用：它们都替你执行工具。
循环自己写。

## `ToolNode` 平时做的四件事，自己补上

| 它做 | 这里 |
| --- | --- |
| 工具异常捕成 `ToolMessage` | `request_tool` 大多是**返回**失败而不是抛；真抛出来的（管道断了、参数送不出去）在这里捕成一条失败的 ToolMessage——**一个工具出错不许炸掉整个循环** |
| `tool_call_id` 必填 | 每条 ToolMessage 都带 `call["id"]`，对得上它回应的是哪一次调用 |
| `max_iterations` | 有。到了上限报 `FAILED`——**它没跑完，不能说"完成"** |
| 异步那一份自己写 | **不写**：worker 本来就是同步的 |

## 停下来等审批 = 存一份 checkpoint

`request_tool` 回 `needs_approval` 时，循环停在原地：把当前消息 + **还没答复的那几条
调用**存进执行者自己的 sqlite，报 `INTERRUPTED` 带上那个引用。宿主批完之后重起这个
worker，`resume_value` 就是那个引用——**同一个调用原样再发一遍**，指纹对上，内核这次
说 `allow`（`core/capability.py` 规则一；参数哈希由宿主现算，这里不送）。

## 落库的是**我们自己的形状**，不是框架的形状

一行消息 = `{"role", "text", "tool_calls", "tool_call_id", "status"}`。`langchain_core`
只在两个转换函数里出现，于是宿主读结果（`adapter.py`）**不装 langchain 也读得动**。

## 工具全名 → 线上名字

绑给模型的是**线上名字**：OpenAI 那一族（DeepSeek 一样）对 `function.name` 只认
`^[a-zA-Z0-9_-]{1,64}$`，而工具全名是 `weather.current` 这种带点的——**点会让整个
请求 400**。所以点换成下划线，回程靠 `by_wire` 换回全名；`request_tool` 拿到的
永远是全名（那是网关认识的那个名字）。

## session 就是那条对话线程

`session_ref` 相同的下一轮 Task 接着上一轮的消息往下走（旧实现用 LangGraph 的
`thread_id` 是同一件事）。没有 `session_ref` 就退到 `task_id`：一个 Task 一条线程。
同一 session 并行跑两个 Task 会互相踩——那是共享一条线程的代价，不额外加锁。
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from src.gateway.function.ports import failed
from src.gateway.permission.decision import DENY, NEEDS_APPROVAL
from src.tasks.channel import COMPLETED, FAILED, INTERRUPTED

#: 基座的清单里没写 prompt 时的兜底。常态是清单里那一份（配置可以整个换掉它）。
DEFAULT_SYSTEM_PROMPT = "你是 OCC 的执行者。用给你的工具把事做完，做完用一句话说清结果。"

#: 循环上限的兜底。清单的 `parameters` 里那一份才是常态。
DEFAULT_MAX_ITERATIONS = 12

#: 旋钮里**能当模型参数用**的那些（名字和 `ChatOpenAI` 对得上）。
_PASS_THROUGH = ("temperature", "max_tokens", "top_p")

#: 线上名字认的字符集：不在这儿的都换掉。
_WIRE_SAFE = re.compile(r"[^a-zA-Z0-9_-]")

#: 线上名字的长度上限（OpenAI 那一族是 64；留几个字符给去重后缀）。
_WIRE_MAX = 56


def thread_of(session_ref: str = "", task_id: str = "") -> str:
    """**会话线程的名字。** `adapter.py` 和这里必须用同一个算法，所以它只住在这里。"""
    return str(session_ref or task_id or "")


def run(*, channel: Any, task_data: dict[str, Any], config_data: dict[str, Any],
        input_text: str, database_path: str, resume_value: Any = None) -> dict[str, Any]:
    """跑一次循环，返回**要报给宿主的那条收尾**（`kind` 加载荷）。

    抛出来的异常交给 `tasks/bootstrap.py` 翻成 `FAILED`——**执行者不对错误分类**，
    它只说"我是怎么结束的"。
    """
    model_spec = dict(config_data.get("model") or {})
    if not model_spec.get("found"):
        raise RuntimeError(
            f"模型引用解析不出来：{model_spec.get('reason') or model_spec or '这份配置没有 model'}")
    key_env = str(model_spec.get("api_key_env") or "")
    if not key_env:
        raise RuntimeError("这份配置没给 api_key_env：密钥只下变量名，而名字也缺着")
    # **密钥只下变量名**，值由这个进程自己从环境里读（`OPEN_ISSUES.md` §一 第 1 条）。
    # 它只进模型的构造参数，不进任何要送回去的载荷。
    api_key = os.environ.get(key_env, "").strip()
    if not api_key:
        raise RuntimeError(f"环境里没有 {key_env}：密钥只下变量名，值由这个进程自己读")

    knobs = dict(config_data.get("parameters") or {})
    tools = [item for item in (config_data.get("tools") or [])
             if isinstance(item, dict) and str(item.get("name") or "")]
    model, by_wire = _bind(_build_model(model_spec, knobs, api_key), tools)
    max_iterations = max(1, int(knobs.get("max_iterations") or DEFAULT_MAX_ITERATIONS))

    journal = Journal(database_path)
    task_id = str(task_data.get("task_id") or "")
    thread = thread_of(str(task_data.get("session_ref") or ""), task_id)
    system = str(dict(config_data.get("prompt") or {}).get("system") or DEFAULT_SYSTEM_PROMPT)

    opening = _opening(str(task_data.get("summary") or ""), input_text)
    messages, pending, step = _resume_or_start(journal, thread, system, opening, resume_value)
    if pending:                                   # 恢复：上次没答完的那几条先重发
        waiting = _answer(channel, pending, messages, by_wire)
        if waiting is not None:                   # 又停在同一件事上：再报一次，不往后退
            return _interrupted(journal, thread, task_id, step, messages, waiting, by_wire)

    while True:
        if step >= max_iterations:
            journal.save_run(thread, task_id, _rows_of(messages, by_wire),
                             status="failed", step=step)
            return {"kind": FAILED,
                    "reason": f"循环到了上限（{max_iterations} 轮），模型还在要工具——"
                              f"要么把 parameters.max_iterations 调大，要么让它别绕圈"}
        step += 1
        response = model.invoke(messages)
        messages.append(response)
        calls = [_call_row(call, by_wire, index)
                 for index, call in enumerate(getattr(response, "tool_calls", None) or [])]

        if calls:
            waiting = _answer(channel, calls, messages, by_wire)
            if waiting is not None:
                return _interrupted(journal, thread, task_id, step, messages, waiting, by_wire)
            journal.save_run(thread, task_id, _rows_of(messages, by_wire),
                             status="running", step=step)
            continue

        # 没有要调的工具 = 模型在说话，那就是结果（"结果取最后一次的输出"）。
        text = _text_of(response)
        if not text.strip():
            # 它既没有说话也没有要工具：**没有结果可以报**。报"完成"的话，内核那边
            # `Complete` 会因为 `result_ref` 是空的而把这条命令拒掉
            # （`core/task.py`），Task 就此停在一个谁也不认的状态上。
            journal.save_run(thread, task_id, _rows_of(messages, by_wire),
                             status="failed", step=step)
            return {"kind": FAILED, "reason": "模型既没有说话也没有要工具——这一次没有结果可以报"}
        journal.save_run(thread, task_id, _rows_of(messages, by_wire),
                         status="completed", step=step, result=text)
        return {"kind": COMPLETED, "result_ref": text}


def _interrupted(journal: "Journal", thread: str, task_id: str, step: int,
                 messages: list[Any], waiting: list[dict[str, Any]],
                 by_wire: dict[str, str]) -> dict[str, Any]:
    """**停下来等审批。** checkpoint 存在前面：报出去的引用要指向一份真的存下来的状态。"""
    reference = f"{thread}:{step}"
    rows = _rows_of(messages, by_wire)
    journal.save_checkpoint(reference, thread=thread, task_id=task_id, step=step,
                            messages=rows, pending=waiting)
    journal.save_run(thread, task_id, rows, status="interrupted", step=step)
    return {"kind": INTERRUPTED, "checkpoint_ref": reference}


# ── 从哪一堆消息开始跑

def _opening(summary: str, input_text: str) -> str:
    """**这一轮用户说的那句话。**

    三样东西各归各位，别混：

    | 宿主给的 | 落到哪儿 |
    | --- | --- |
    | 智能体配置里的 `prompt.system` | system 消息（基座声明、配置可覆盖） |
    | **委托摘要**（`task_data["summary"]`） | **第一条 user 消息**——它就是"用户说的话" |
    | 输入引用的文件正文（`input_text`） | 随信附的材料，接在摘要后面 |

    **摘要以前根本没进来过**：循环只把文件正文当 user 消息，于是"输入引用留空 +
    摘要写着一句话"这种最自然的用法，模型收到的是**一条空消息**——它只能反问
    "你想让我做什么"，而答案就在摘要里。（实测：task-c5166… 的 human 消息是空的。）

    材料为空就只发摘要，摘要为空就只发材料：**两条都空就发一条空消息**——
    那是调用方的问题，不是这里的判断（`create_task` 只要求 summary 非空）。
    """
    summary, body = summary.strip(), input_text.strip()
    if summary and body:
        return f"{summary}\n\n---\n\n{body}"
    return summary or body


def _resume_or_start(journal: "Journal", thread: str, system: str, opening: str,
                     resume_value: Any) -> tuple[list[Any], list[dict[str, Any]], int]:
    """返回（消息、还没答完的调用、走到第几步）。

    **恢复**要接着那一份跑：找不到就抛，不"从头再来一遍"——重跑会重做副作用，
    而用户批的是**那一次调用**。**新的一轮**接着会话的历史走：session 就是那条线程。
    """
    reference = str(resume_value or "")
    if reference:
        saved = journal.checkpoint(reference)
        if saved is None or not saved["messages"]:
            raise RuntimeError(
                f"找不到 checkpoint {reference!r}：恢复要接着那一份跑，而这份不在执行者的库里")
        return ([_to_message(row) for row in saved["messages"]],
                [dict(call) for call in saved["pending"]], int(saved["step"]))
    history = _trim_dangling(journal.history(thread))
    if history:
        return [_to_message(row) for row in history] + [_human(opening)], [], 0
    return [_system(system), _human(opening)], [], 0


def _trim_dangling(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """剪掉尾巴上**没答完的那一次调用**。

    一条 AI 消息声明了 3 个调用、只答了 1 个（第 2 个停下来等审批），这一串原样
    发回给模型是**不合法的**（每个 `tool_call_id` 都必须有应答）。会话里留下这种
    尾巴是常态（停过审批、或者被取消过），所以下一轮开工前先剪掉它。
    """
    rows = list(rows)
    while True:
        index = next((position for position in range(len(rows) - 1, -1, -1)
                      if rows[position].get("role") == "ai"), None)
        if index is None:
            return rows
        answered = {row.get("tool_call_id") for row in rows[index + 1:]
                    if row.get("role") == "tool"}
        calls = rows[index].get("tool_calls") or []
        if all(call.get("id") in answered for call in calls):
            return rows
        rows = rows[:index]


# ── 一次工具调用

def _answer(channel: Any, calls: list[dict[str, Any]], messages: list[Any],
            by_wire: dict[str, str]) -> list[dict[str, Any]] | None:
    """逐条送出去，答复翻成 `ToolMessage`。

    **返回停下来时"还没答复的那些"**（含当前这条）——checkpoint 存的就是它们。
    都答完了返回 `None`。
    """
    for position, call in enumerate(calls):
        try:
            answer = channel.request_tool(str(call["tool_id"]), dict(call["args"]))
        except Exception as exc:            # noqa: BLE001 — 工具这一层不许炸掉循环
            answer = failed(str(call["tool_id"]), f"没送出去: {type(exc).__name__}: {exc}")
        if answer.decision == NEEDS_APPROVAL:
            return calls[position:]
        # **拒绝和失败都走这一条**：模型要能看见"这次没成"，然后接着干。
        messages.append(_tool_message(call, answer))
    return None


def _tool_message(call: dict[str, Any], answer: Any) -> Any:
    from langchain_core.messages import ToolMessage

    if answer.ok:
        return ToolMessage(content=_as_text(answer.result), tool_call_id=str(call["id"]),
                           name=str(call["name"]), status="success")
    failure: dict[str, Any] = {"error": str(answer.error or "工具调用没成")}
    if answer.decision == DENY:
        failure["denied"] = True
    return ToolMessage(content=json.dumps(failure, ensure_ascii=False),
                       tool_call_id=str(call["id"]), name=str(call["name"]), status="error")


# ── 模型

def _build_model(model_spec: dict[str, Any], knobs: dict[str, Any], api_key: str) -> Any:
    """按供应商那份**终值**造模型。

    供应商的 `model_parameters` 是**模型的事实**（这一家给这个模型的推荐设置），
    旋钮是**配置的话**——同名时以旋钮为准（`extensions/executors.py` 那张三类表）。
    """
    from langchain_openai import ChatOpenAI

    facts = dict(model_spec.get("model_parameters") or {})
    kwargs: dict[str, Any] = {name: facts[name] for name in _PASS_THROUGH
                              if facts.get(name) is not None}
    kwargs.update({name: knobs[name] for name in _PASS_THROUGH
                   if knobs.get(name) is not None})
    if knobs.get("timeout_seconds") is not None:
        kwargs["timeout"] = float(knobs["timeout_seconds"])
    base_url = str(model_spec.get("base_url") or "")
    return ChatOpenAI(model=str(model_spec.get("model") or ""), api_key=api_key,
                      **({"base_url": base_url} if base_url else {}), **kwargs)


def _bind(model: Any, tools: list[dict[str, Any]]) -> tuple[Any, dict[str, str]]:
    """**契约四**：绑给模型的是 schema 字典。返回（绑好的模型，线上名字 → 工具全名）。"""
    by_wire: dict[str, str] = {}
    binding: list[dict[str, Any]] = []
    for item in tools:
        tool_id = str(item.get("name") or "")
        wire = _wire_name(tool_id, by_wire)
        by_wire[wire] = tool_id
        binding.append({
            "name": wire,
            "description": str(item.get("description") or ""),
            "parameters": item.get("input_schema") or {"type": "object", "properties": {}},
        })
    return (model.bind_tools(binding) if binding else model), by_wire


def _wire_name(tool_id: str, taken: dict[str, str]) -> str:
    """工具全名 → **线上名字**（见模块说明最后一段：点会让请求整个 400）。"""
    base = _WIRE_SAFE.sub("_", tool_id)[:_WIRE_MAX] or "tool"
    wire, index = base, 2
    while wire in taken and taken[wire] != tool_id:
        wire, index = f"{base}_{index}", index + 1
    return wire


# ── 消息：langchain 那一侧 ↔ 我们存的那一侧

def _system(text: str) -> Any:
    from langchain_core.messages import SystemMessage
    return SystemMessage(text)


def _human(text: str) -> Any:
    from langchain_core.messages import HumanMessage
    return HumanMessage(text)


def _call_row(call: dict[str, Any], by_wire: dict[str, str], index: int) -> dict[str, Any]:
    wire = str(call.get("name") or "")
    return {"id": str(call.get("id") or f"call_{index}"), "name": wire,
            "tool_id": by_wire.get(wire, wire), "args": dict(call.get("args") or {})}


def _row_of(message: Any, by_wire: dict[str, str]) -> dict[str, Any]:
    """一条消息 → 存在库里的一行。**形状是我们的**（`adapter.py` 照这个读）。"""
    role = {"system": "system", "human": "human", "ai": "ai",
            "tool": "tool"}.get(str(getattr(message, "type", "")), "other")
    row: dict[str, Any] = {"role": role, "text": _text_of(message)}
    if role == "ai":
        row["tool_calls"] = [_call_row(call, by_wire, index)
                             for index, call in enumerate(getattr(message, "tool_calls", None) or [])]
    if role == "tool":
        name = str(getattr(message, "name", "") or "")
        row["tool_call_id"] = str(getattr(message, "tool_call_id", "") or "")
        row["name"] = name
        row["tool_id"] = by_wire.get(name, name)
        row["status"] = str(getattr(message, "status", "") or "success")
    return row


def _to_message(row: dict[str, Any]) -> Any:
    """存的那一行 → 一条消息（恢复时用）。"""
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

    role, text = str(row.get("role") or ""), str(row.get("text") or "")
    if role == "system":
        return SystemMessage(text)
    if role == "ai":
        calls = [{"name": str(call.get("name") or call.get("tool_id") or ""),
                  "args": dict(call.get("args") or {}), "id": str(call.get("id") or "")}
                 for call in (row.get("tool_calls") or [])]
        return AIMessage(content=text, tool_calls=calls)
    if role == "tool":
        return ToolMessage(content=text, tool_call_id=str(row.get("tool_call_id") or ""),
                           name=str(row.get("name") or ""),
                           status=str(row.get("status") or "success"))
    # 人话和认不出的角色都当人话念一遍：**宁可多念一句，不可丢一条**。
    return HumanMessage(text)


def _rows_of(messages: list[Any], by_wire: dict[str, str]) -> list[dict[str, Any]]:
    return [_row_of(message, by_wire) for message in messages]


def _text_of(message: Any) -> str:
    """消息正文。**内容块拼起来**（新写法下 content 可以是一串块，不是字符串）。"""
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                parts.append(str(block.get("text") or ""))
            else:
                parts.append(str(block))
        return "".join(part for part in parts if part)
    return str(content or "")


def _as_text(value: Any) -> str:
    """工具结果 → 喂回模型的那段字。**字符串原样，别的转 JSON**（模型看得懂 JSON）。"""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


# ── 执行者自己的那本账

class Journal:
    """checkpoint（恢复的锚点）+ 每次运行的最后一份状态，都在**执行者自己的** sqlite 里。

    那个文件是宿主给的 `database_path`（`Settings.executor_data`），**不是控制库**——
    worker 从不打开控制库。表名带包的前缀：那个文件是所有执行者共用的一个，
    不带前缀就会和别人的表撞。

    每条记录都收 `task_id`：session 是一条共享的对话线程，而"结果是哪个 Task 的"
    不能靠线程名去猜。
    """

    def __init__(self, database_path: str | Path) -> None:
        self.path = Path(database_path)

    @contextmanager
    def _open(self) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            connection.row_factory = sqlite3.Row
            connection.executescript(_SCHEMA)
            yield connection
            connection.commit()
        finally:
            connection.close()

    # 写（worker 那一侧）

    def save_checkpoint(self, reference: str, *, thread: str, task_id: str, step: int,
                        messages: list[dict[str, Any]],
                        pending: list[dict[str, Any]]) -> None:
        state = json.dumps({"messages": messages, "pending": pending}, ensure_ascii=False)
        with self._open() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO langgraph_checkpoints"
                " (ref, thread, task_id, step, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (reference, thread, task_id, step, state, _now()))

    def save_run(self, thread: str, task_id: str, messages: list[dict[str, Any]], *,
                 status: str, step: int, result: str = "") -> None:
        state = json.dumps({"messages": messages}, ensure_ascii=False)
        with self._open() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO langgraph_runs"
                " (thread, task_id, status, step, result, state, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (thread, task_id, status, step, result, state, _now()))

    # 读（worker 和 adapter 都走这里：**形状只有一处**）

    def checkpoint(self, reference: str) -> dict[str, Any] | None:
        with self._open() as connection:
            row = connection.execute("SELECT * FROM langgraph_checkpoints WHERE ref = ?",
                                     (str(reference),)).fetchone()
        if row is None:
            return None
        state = _json(row["state"])
        return {"ref": str(row["ref"]), "thread": str(row["thread"]),
                "task_id": str(row["task_id"]), "step": int(row["step"] or 0),
                "messages": list(state.get("messages") or []),
                "pending": list(state.get("pending") or []),
                "created_at": str(row["created_at"])}

    def run(self, thread: str, task_id: str) -> dict[str, Any] | None:
        """这个 Task 在这一条线程上的那一份。**按两个键找**，不靠"最新那份"猜。"""
        with self._open() as connection:
            row = connection.execute(
                "SELECT * FROM langgraph_runs WHERE thread = ? AND task_id = ?",
                (str(thread), str(task_id))).fetchone()
        return _run_row(row) if row is not None else None

    def history(self, thread: str) -> list[dict[str, Any]]:
        """这条线程上最近那一份消息——**下一轮接着它走**。"""
        with self._open() as connection:
            row = connection.execute(
                "SELECT * FROM langgraph_runs WHERE thread = ?"
                " ORDER BY updated_at DESC, rowid DESC LIMIT 1", (str(thread),)).fetchone()
        if row is None:
            return []
        return list(_json(row["state"]).get("messages") or [])


_SCHEMA = """
CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
    ref TEXT PRIMARY KEY,
    thread TEXT NOT NULL DEFAULT '',
    task_id TEXT NOT NULL DEFAULT '',
    step INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS langgraph_runs (
    thread TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    step INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (thread, task_id)
);
"""


def _run_row(row: sqlite3.Row) -> dict[str, Any]:
    return {"thread": str(row["thread"]), "task_id": str(row["task_id"]),
            "status": str(row["status"]), "step": int(row["step"] or 0),
            "result": str(row["result"] or ""),
            "messages": list(_json(row["state"]).get("messages") or []),
            "updated_at": str(row["updated_at"])}


def _json(text: Any) -> dict[str, Any]:
    try:
        loaded = json.loads(str(text or "{}"))
    except ValueError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
