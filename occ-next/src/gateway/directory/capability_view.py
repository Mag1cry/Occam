"""按执行者看能力的叠加：**声明是地板，使用方只能收紧**。

同一个工具，不同的执行者看到的审批要求可以不同——因为使用方只能往**严**的方向动。

```text
生效值 = 声明的地板 or 这个执行者收紧过
```

只存"收紧"这一个方向，所以包作者把声明从 `true` 改成 `false` 时，
**收紧过的执行者仍然是严的**（ADR-027）。

## 它读两个列表，自己不是一个

一次判决要问三件事，**顺序就是这张表**：

| # | 问 | 答不上来的时候说什么 |
| --- | --- | --- |
| ① | 这个工具**声明过**吗 | `没有这个工具` ／ `供给 X 现在不可用（关着/起不来）` ／ `X 里没有这个函数` |
| ② | 这个执行者**被允许**用它吗 | `X 没有被允许使用 Y（tools_from 里没有它）` |
| ③ | 要不要人批 | 声明的地板 or 这个执行者收紧过 |

**三级答案不能塌成一句"没有"**：一个是你写错了名字，一个是那东西还在、只是关着——
它们要人去改的地方不一样。

## 「看得见」和「做得了」是两件事

| | 谁定 | 回答什么 |
| --- | --- | --- |
| 清单（`visible_to`） | `tools_from` | worker **看得见**什么 |
| 判决（`allows` / `approval_for`） | 这里 + `function/pipeline.py` | 它**做得了**什么 |

两个都要有：只有清单等于把边界交给 worker 自觉；只有判决等于它连自己要调的东西
存不存在都不知道。而判决必须是**默认拒绝**的——没有 `tools_from` 就一个都调不动。

← 来自 composition/capability_view.py（从装饰器变成普通读）
"""
from __future__ import annotations

from ..function.ports import ToolSpec
from ..permission.judge import Requirement
from .capabilities import CapabilityDirectory, Supply
from .executors import ExecutorDirectory


class CapabilityView:
    def __init__(self, capabilities: CapabilityDirectory,
                 executors: ExecutorDirectory) -> None:
        self.capabilities = capabilities
        self.executors = executors

    # ── 判决读的三问

    def supply_of(self, tool_id: str) -> Supply | None:
        """这个工具全名属于哪台供给。**关着的也算**——它在列表里。"""
        return self.capabilities.get(tool_id)

    def declared(self, tool_id: str) -> Requirement:
        """"这个工具存在吗"就是"它被声明过吗"——**声明本身就是允许**。"""
        supply = self.supply_of(tool_id)
        if supply is None:
            return Requirement(False, f"没有这个工具: {tool_id}")
        if not supply.usable:
            return Requirement(False, f"供给 {supply.name} 现在不可用（{supply.detail}）")
        if supply.tool(tool_id) is None:
            return Requirement(False, f"供给 {supply.name} 里没有这个函数: {tool_id}")
        return Requirement(True)

    def allows(self, executor_ref: str, tool_id: str) -> Requirement:
        """这个执行者**被允许**用这个工具吗？**默认拒绝。**

        允许与否只看一件事：它所在的那台供给在不在这个执行者的 `tools_from` 里。
        没有 `tools_from` 就是没有允许——名单为空等于一个都不许。
        """
        definition = self.executors.get(executor_ref)
        if definition is None:
            return Requirement(False, f"没有这个执行者: {executor_ref}")
        supply = self.supply_of(tool_id)
        if supply is None:
            return Requirement(False, f"没有这个工具: {tool_id}")
        if supply.name not in definition.tools_from:
            return Requirement(
                False, f"{executor_ref} 没有被允许使用 {supply.name}（tools_from 里没有它）")
        return Requirement(True)

    def approval_for(self, executor_ref: str, tool_id: str) -> bool:
        """**生效的审批要求**：声明的地板，或者这个执行者收紧过。"""
        supply = self.supply_of(tool_id)
        if supply is None:
            return True                    # 判不到的东西一律当成要批（fail-closed）
        definition = self.executors.get(executor_ref)
        tightened = bool(definition) and tool_id in definition.tighten
        return supply.approval_required or tightened

    # ── 给 worker 的那份清单

    def visible_to(self, executor_ref: str) -> tuple[ToolSpec, ...]:
        """worker 看得见的工具：它那几台供给里，**现在能用的**那些。

        只给名字、描述、schema——**可序列化的数据**，不是句柄（`function/ports.py`）。
        关着的供给不在里面：它连工具清单都还没有（要跑起来才知道有哪些函数）。
        """
        definition = self.executors.get(executor_ref)
        if definition is None:
            return ()
        return tuple(
            spec
            for supply in self.capabilities.all()
            if supply.usable and supply.name in definition.tools_from
            for spec in supply.tools
        )
