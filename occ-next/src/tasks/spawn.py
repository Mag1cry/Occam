"""组装启动参数 + 起停进程。

**它现在是"组装"和"机械动作"两件事合在一处**——以前分成两个文件，因为"机械的进程动作"
看上去可以复用。**但只有 Worker 要起进程**：包内工具就是一个单例，直接调函数，不起进程。
复用对象没了，拆开就只剩两处互相跳。

| 它做两件事 | |
| --- | --- |
| **组装**：执行者定义 + 这个 Task → 一份纯数据的启动计划 | 知道执行者是什么 |
| **起停**：`start` / `terminate` / `close` | 不知道执行者是什么 |

## 为什么用 `spawn` 而不是 `fork`

子进程要重新 import 一遍入口，所以**不能传一个动态 import 出来的函数对象**——
`multiprocessing` 序列化不了它。传的是 `bootstrap.py` 这个**顶层函数**加一份纯数据。
这条在 Windows 上是硬要求，在 Linux 上也一样成立（别依赖 fork）。

## daemon 的取舍

`daemon=True`：父解释器正常退出时子进程一起走，正常路径下不留孤儿。它**覆盖不了**
SIGKILL / `taskkill /F`，所以异常退出那条路仍然要靠 `probe.py` 的"待对账"。

Worker 自己不创建子进程，所以 daemon 那条"不能有子进程"的限制不冲突。

## `terminate` 要**说出来成没成**

`Process.terminate()` 只是把信号递过去，它不保证进程真的退了。旧代码忽略这个结果，
于是"没杀干净"和"杀干净了"在控制侧一模一样——而没杀干净的那个，正是**重启之后
再也不被探测**的那一类（`reconcile.py` 探的是"还开着的启动记录"）。
所以这里返回布尔值，调用方必须拿着它决定下一步。

← 来自 control/process_supervisor.py
"""
from __future__ import annotations

import multiprocessing
from dataclasses import dataclass, field
from typing import Any

from .bootstrap import worker_bootstrap

#: 正常收尾的等待时间（秒）。超了就认为"它没理我们"，返回 False。
TERMINATE_SECONDS = 2.0


@dataclass(frozen=True)
class LaunchPlan:
    """一次启动要的全部东西。**纯数据**——它要过 spawn 的序列化。"""

    descriptor: dict[str, Any]
    task_data: dict[str, Any]
    config_data: dict[str, Any] = field(default_factory=dict)
    input_text: str = ""
    database_path: str = ""
    resume_value: Any = None


class WorkerProcess:
    """一个跑起来的 worker：进程 + 管道这一头。"""

    def __init__(self, process: Any, connection: Any, process_id: int) -> None:
        self.process = process
        self.connection = connection
        self.process_id = process_id

    @property
    def alive(self) -> bool:
        return bool(self.process.is_alive())

    def terminate(self) -> bool:
        """叫它停。**返回它是不是真的停了**——没停的话，那是一条要被记下来的事实。"""
        if not self.alive:
            return True
        self.process.terminate()
        self.process.join(TERMINATE_SECONDS)
        return not self.alive

    def close(self) -> None:
        """把管道这一头收掉。**不杀进程**——杀是 `terminate` 的事，两件事别混。"""
        try:
            self.connection.close()
        except OSError:
            pass


class WorkerSpawner:
    def __init__(self, context: Any = None) -> None:
        # `spawn` 是硬要求（见文件说明），所以上下文在这里定死，不给"顺手改成 fork"的机会。
        self.context = context or multiprocessing.get_context("spawn")

    def start(self, plan: LaunchPlan) -> WorkerProcess:
        parent, child = self.context.Pipe(duplex=True)
        process = self.context.Process(
            target=worker_bootstrap,
            args=(plan.descriptor, child, plan.task_data, plan.config_data,
                  plan.input_text, plan.database_path, plan.resume_value),
            daemon=True,
            name=f"occ-worker-{plan.task_data.get('task_id', '?')}",
        )
        process.start()
        # 子进程那一头由它自己持有；**宿主这一头必须把它放掉**，否则管道不会被关，
        # 对面读到的是"还有人拿着"而不是 EOF。
        child.close()
        return WorkerProcess(process, parent, int(process.pid or 0))
