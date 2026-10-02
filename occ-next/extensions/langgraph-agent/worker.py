"""官方 LLM 执行者的入口：**契约一 + 契约二**，两页加起来就是这三十行。

六个位置参数、三种收尾。它自己不判决、不给错误分类、不打开控制库——要工具只有
`channel.request_tool` 一条路（契约三），循环本身在 `graph.py`。

## 密钥只下变量名

`config_data["model"]["api_key_env"]` 是个**环境变量名**，值由这个进程自己从环境里
读（`OPEN_ISSUES.md` §一 第 1 条定的那条边界）。所以这里没有任何一处把密钥写进
要送回去的载荷里——它连密钥本身都没见过。

## 漏出来的异常不在这里收

`tasks/bootstrap.py` 已经接住了包入口抛的一切并翻成 `FAILED`（原因带上类型名）。
这里再兜一层，等于同一个"其他任何异常"在两个地方各说一遍。
"""
from __future__ import annotations

from typing import Any

from src.tasks.channel import FAILED, REPORTS, WorkerChannel

from .graph import run                      # 模型、循环、checkpoint 都在它那儿


def worker_entry(connection: Any, task_data: dict[str, Any], config_data: dict[str, Any],
                 input_text: str, database_path: str, resume_value: Any = None) -> None:
    channel = WorkerChannel(connection, str(task_data.get("task_id") or ""))
    report = run(channel=channel, task_data=task_data, config_data=config_data,
                 input_text=input_text, database_path=database_path, resume_value=resume_value)
    kind = str(report.get("kind") or "")
    if kind not in REPORTS:
        # **收尾是封闭集合**：多一个词立刻要回答"那它落到哪个状态"（契约二）。
        channel.report(FAILED, {"reason": f"循环给了一个不是收尾的 kind: {kind!r}"})
        return
    channel.report(kind, {key: value for key, value in report.items() if key != "kind"})
