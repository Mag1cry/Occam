"""SSE 事实流：**只标记「谁脏了」**，不承载状态。

推的是"这个对象变了"，不是"它现在是什么"。前端收到之后**自己去重读**（ADR-031）。

**为什么必须这样**：两侧各算一遍状态就是漂移的来源。今天推一份快照、明天推一份差异，
迟早会出现"推过来的"和"读回来的"不一致——而**没有一个办法判断哪个对**。

只推"脏了"就没有这个问题：事实只有一个来源（重读），推送只负责说"该重读了"。

## 断线重连要认 `Last-Event-ID`

`EventSource` 自动重连时带的是 **`Last-Event-ID` 请求头**，不是查询参数。只读查询参数的话，
前端第一次重连就会**从 0 全量重放**（`OPEN_ISSUES.md` 里那条）。所以两个都认：
头优先，查询参数兜底（手动指定游标的场合）。

## 心跳必须是**看得见的一帧**

空闲时要说话，否则中间的代理会把连接掐掉。但**不能发注释行**（": 心跳"）：
浏览器按 SSE 的规矩不把注释交给 JS，于是"流还活着"和"流已经悄悄断了"在前端看起来
一模一样——它那条"多久没听见后端说话"的看门狗会一直判你断线，然后无休止地重连。

所以心跳是一条 `data:` 帧，里面**没有脏标记**（只有 `heartbeat`）：前端收到就当
"后端还在"，**不去重读快照**。

← 来自 web.py::gateway_events
"""
from __future__ import annotations

import json
import time
from typing import Any, Iterator

#: 安静多久发一次心跳（秒）。**它得和前端的容忍时间配成对**：前端那条看门狗
#: （`occ-command-center/src/api/gateway.ts` 的 `HEARTBEAT_TIMEOUT_MS`）是 6 秒，
#: 这里必须明显短于它——不然**后端好好的，前端却判它断了**，然后无休止重连。
HEARTBEAT_SECONDS = 2.0

#: 心跳那一帧的内容。**它不带 `id:`**——带了就推进了游标，等于把下一次重连
#: 该读的那段跳过去。**它也不带脏标记**：收到它只是"后端还在"，不是"该重读了"。
HEARTBEAT_FRAME = '{"heartbeat": true}'

#: 一次读多少条。**有上限**——不然一个积压了很久的流会一次性灌满前端。
BATCH = 200


def cursor_from(headers: Any, query: Any) -> int:
    """**头优先，查询参数兜底。** 浏览器自动重连带的是头。"""
    raw = ""
    try:
        raw = str(headers.get("last-event-id") or headers.get("Last-Event-ID") or "")
    except Exception:                         # noqa: BLE001 — 头拿不到就当没有
        raw = ""
    if not raw:
        try:
            raw = str(query.get("cursor") or query.get("last_event_id") or "")
        except Exception:                     # noqa: BLE001
            raw = ""
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


def frames(audit: Any, cursor: int, *, stop: Any = None,
           heartbeat: float | None = None, batch: int = BATCH) -> Iterator[str]:
    """一直读下去，直到 `stop` 被设上（关停）或者调用方断开。

    每条事件的形式：`id: <seq>` + `data: {"subject_ref": ...}`——
    `id` 是**下一次重连要带回来的游标**，这就是它必须躺在协议里的原因。

    `heartbeat` 给 `None` 就用模块里那个默认值（**读在调用时，不在导入时**——
    导入时定死的话，测试要把它调快就得重载模块）。
    """
    pause = HEARTBEAT_SECONDS if heartbeat is None else float(heartbeat)
    while stop is None or not stop.is_set():
        events = audit.after(cursor, limit=batch)
        if not events:
            yield f"data: {HEARTBEAT_FRAME}\n\n"
            if stop is not None:
                stop.wait(pause)        # 关停时**不用等满一个心跳**
            else:
                time.sleep(pause)
            continue
        for event in events:
            cursor = max(cursor, int(event.seq))
            yield _frame(event)
        # **不 sleep**：积压了就直接接着读，别让前端等一个心跳周期。


def _frame(event: Any) -> str:
    payload = {"seq": int(event.seq), "command": event.command,
               "subject_ref": event.subject_ref, "occurred_at": event.occurred_at}
    return f"id: {int(event.seq)}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
