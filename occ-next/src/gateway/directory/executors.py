"""**执行者列表**：有哪些执行者、它们是什么。

和 `capabilities.py` 一样——**它就是一个列表**，而且**全量登记**：声明里写了几条就有几条，
开着的、关着的、起不来的都在。定义（worker 入口、模型、prompt、能用哪些工具）由
`extensions/executors.py` 从声明造出来，"它为什么跑不了"跟着定义走（`why_not`）。

## 两个问题各答一次，别混

| 问 | 谁答 |
| --- | --- |
| 这个引用**能不能被解析**？ | `get` / `exists` |
| 它**能不能被新建引用**？ | `can_run` / `public_configs` |

**能不能读回**和**能不能新建**是两个问题（ADR-024）：一个停用的执行者仍要能被解析，
否则引用它的历史 Task 整个界面打不开。

## "能不能跑"是三件事

**开着没有**（声明）× **有没有毛病**（起不来是因为基座不在、模型没给）× **有没有代码**。
三条各自有各自的说法，所以`why_not` 说的就是**第一条不成立的那一条**——用户看到的是
"我该去改哪儿"，不是一句"它不能用"。

## 谁读它

判决（这个执行者被允许用哪些工具 —— 读 `tools_from`）和 `tasks/` 起 worker。
**单向的**：这一层不 import `tasks/`。

← 来自 executors/config.py + executors/registry.py 的查找部分
"""
from __future__ import annotations

from ...extensions.executors import ExecutorDefinition


class ExecutorDirectory:
    def __init__(self) -> None:
        self._items: tuple[ExecutorDefinition, ...] = ()

    def replace(self, items: tuple[ExecutorDefinition, ...]) -> None:
        self._items = tuple(items)

    def all(self) -> tuple[ExecutorDefinition, ...]:
        return self._items

    def get(self, name: str) -> ExecutorDefinition | None:
        """**能不能被解析。** 关着的、起不来的，只要声明里写过就答得出来。"""
        for item in self._items:
            if item.name == name:
                return item
        return None

    def exists(self, name: str) -> bool:
        return self.get(name) is not None

    def can_run(self, name: str) -> bool:
        """**能不能被新建引用。**"""
        found = self.get(name)
        return bool(found and found.runnable)

    def why_not(self, name: str) -> str:
        """不能跑的原因——**说给人听的那一句**。"""
        found = self.get(name)
        if found is None:
            return f"没有这个执行者: {name}"
        return found.why_not

    def public_configs(self) -> tuple[ExecutorDefinition, ...]:
        """能新建引用的那些。前端用它渲染"可以挑哪些"。"""
        return tuple(item for item in self._items if item.runnable)
