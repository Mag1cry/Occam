"""扫描 / 加载失败的诊断：**一套形状，不是两套**。

旧代码里同一个东西有两个样子——包描述符上挂的是对象、`ExtensionRecord` 上挂的是
`__dict__` 的拷贝（`loader.py:317`）、`ExtensionLoadResult` 上又是对象。
三种形状让"这条诊断是从哪来的"变成一道推理题，而它本来只是一条记录。

## 一条诊断记什么

| 栏 | 回答什么 |
| --- | --- |
| `package` / `path` | **是谁**——读不出 `id` 的时候退到目录名，因为"这个目录坏了"也要说得出来 |
| `stage` | 它在**哪一步**坏的：`scan`（还没 import）/ `load`（正在加载）/ `start`（加载完了起不来）|
| `message` | 为什么坏——**用人话**，因为读它的人是要去改声明的那个 |
| `imported` | 这段代码**有没有进宿主进程**——它是用户分清"重试一下"和"重新识别一遍"的**唯一**依据 |

## 为什么要有 `imported`

"这个包没起来"有两种，处置完全不同：

- **import 之前就失败了**（撞名、清单读不出来）→ 改完**重试**就行
- **import 之后才失败**（起不来、连不上）→ 代码**已经在宿主进程里**了，
  "禁用"卸不干净，得**重新识别**（全量重来）

不说清这一格，用户只能靠猜——而猜错了的代价是"我明明禁用了它怎么还在跑"。

**诊断不落库**（ADR-028）。所以它只活在"这一次扫描/加载的结果"里，
重启之后"上次为什么没起来"就没有了——这条记在 `OPEN_ISSUES.md` 里。
"""

from __future__ import annotations

from dataclasses import dataclass

#: 三个阶段的固定词。别在调用点手写字符串——拼错了没人报错。
STAGES = frozenset({"scan", "load", "start"})


@dataclass(frozen=True)
class Diagnostic:
    """一条"哪个包在哪一步为什么没起来"。"""

    package: str
    path: str
    stage: str
    message: str
    imported: bool = False

    def __post_init__(self) -> None:
        if self.stage not in STAGES:
            raise ValueError(f"非法诊断阶段: {self.stage}")
