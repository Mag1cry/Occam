"""spawn-safe 的 Worker 入口——**宿主提供，但跑在子进程里**。

它是一条**顶层函数**，因为它要被 `multiprocessing` 序列化过去：动态 import 出来的函数
对象传不过去。所以传的是"这个顶层函数 + 一份纯数据 descriptor"，到了那一侧再 import
包里的入口。

```python
def worker_bootstrap(descriptor, connection, task_data, config_data,
                     input_text, database_path, resume_value=None):
    entrypoint = load_entrypoint(Path(descriptor["root"]), descriptor["entrypoint"])
    entrypoint(connection, task_data, config_data, input_text, database_path, resume_value)
```

**它和 `channel.py` 是一对**：这份文件负责"把包里的入口叫起来"，`channel.py` 负责
"叫起来之后它怎么说话"。两个都在子进程这一侧；包作者读的是后者的契约。

## 出错了也要留一句话

包里的入口抛异常时，**不能就这么让管道静默关上**——那在宿主看来和"进程被杀了"长得
一模一样（宿主那边会把它收成 `failed`，但**原因丢了**）。所以这里捕获之后尽力发一条
`failed_report` 出去；发不出去就算了，管道可能已经断了。

**接的是 `Exception`，不是 `BaseException`**：`KeyboardInterrupt` / `SystemExit` 是
"这个进程被人按住了"，那时候该让进程真的退掉，而不是把它翻成一条业务报告。

← 来自 control/worker_bootstrap.py
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..extensions.runtime import load_entrypoint
from .channel import FAILED, WorkerChannel


def worker_bootstrap(descriptor: dict[str, Any], connection: Any, task_data: dict[str, Any],
                     config_data: dict[str, Any], input_text: str, database_path: str,
                     resume_value: Any = None) -> None:
    """子进程的第一行。**它只做两件事**：把入口取回来、叫它。

    自己不记日志、不写库、不连任何东西——**它还什么都没被告知**，也正因如此，
    它才不需要知道那些。
    """
    channel = WorkerChannel(connection, str(task_data.get("task_id") or ""))
    try:
        entrypoint = load_entrypoint(Path(str(descriptor.get("root") or ".")),
                                     str(descriptor.get("entrypoint") or ""))
    except Exception as exc:                       # noqa: BLE001 — 起不来也要说一句
        channel.report(FAILED, {"reason": f"执行者入口加载失败: {type(exc).__name__}: {exc}"})
        return
    if not callable(entrypoint):
        channel.report(FAILED, {"reason": f"执行者入口不是可调用的: {descriptor.get('entrypoint')}"})
        return
    try:
        entrypoint(connection, task_data, config_data, input_text, database_path, resume_value)
    except Exception as exc:                       # noqa: BLE001 — 见文件说明最后一段
        channel.report(FAILED, {"reason": f"{type(exc).__name__}: {exc}"})
