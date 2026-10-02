"""三态引用解析：**可解析 / 已下线 / 未知**。

状态一律来自对象**重读**（ADR-031）——刷新时读不到，就是不存在，**没有墓碑**。

| 态 | 什么时候 |
| --- | --- |
| 可解析 | 声明里写了，而且加载成功、现在可用 |
| 已下线 | **声明里写了，但当前不可用**：`enabled: false`，或起不来 |
| 未知 | 声明里没有——含读不出来、校验不过的，它从来没被承认过 |

禁用的东西会答"已下线"而不是"未知"，因为它在声明层已经登记了。**这个区别必须说得出来**：
一个能说清原因，一个只能承认不知道。

## 为什么不是一个 bool

一个 `exists()` 同时承担"能不能被新建引用"和"历史能不能读回"，未命中时抛错——而这个
调用在列表推导里，于是**一条历史记录引用了一个已删掉的执行者，整个界面打不开**。
三态就是为了这件事（ADR-024）。

**两个问题各答一次**：`state` 答"读得回来吗"，`referable` 答"能新建引用吗"。
两者不同的时候正是最要紧的时候——一个停用的执行者，历史读得回来，但不该被新建引用。

← 来自 gateway.py::resolve_reference / _resolves / _object_ref_for
"""
from __future__ import annotations

from dataclasses import dataclass

from ..gateway.directory import Registry

RESOLVABLE = "resolvable"
OFFLINE = "offline"
UNKNOWN = "unknown"

#: 认得哪几种引用。**这就是"引用"的封闭集合**——声明里跨容器指来指去的那些。
KINDS = ("executor", "supply", "provider", "schedule")


@dataclass(frozen=True)
class Reference:
    kind: str
    name: str
    state: str
    detail: str = ""

    @property
    def readable(self) -> bool:
        """历史读得回来吗——**已下线也算读得回来**（它在声明里，有名字有归属）。"""
        return self.state in (RESOLVABLE, OFFLINE)

    @property
    def referable(self) -> bool:
        """能新建引用吗。"""
        return self.state == RESOLVABLE


def resolve(kind: str, name: str, *, registry: Registry) -> Reference:
    """**认不出的引用答 `unknown`，不抛。** 三态里最后那一态就是"系统不知道它是什么"，
    而一个写错种类的引用正是那个意思——报一条错只会让调用方去猜。"""
    if kind not in KINDS:
        return Reference(str(kind or "?"), str(name or ""), UNKNOWN,
                         f"不认识的引用种类（只能是 {' / '.join(KINDS)}）")
    return _RESOLVERS[kind](str(name or ""), registry)


def _executor(name: str, registry: Registry) -> Reference:
    definition = registry.executors.get(name)
    if definition is None:
        return Reference("executor", name, UNKNOWN, "声明里没有这个执行者")
    if not definition.runnable:
        # **在声明里写过，只是现在用不了**（关着 / 起不来 / 没配模型）。
        return Reference("executor", name, OFFLINE, definition.why_not)
    return Reference("executor", name, RESOLVABLE)


def _supply(name: str, registry: Registry) -> Reference:
    """供给：**工具那一级没有函数名可判**（关着的那台问不出来），所以看的是供给本身。"""
    supply = registry.capabilities.supply(name)
    if supply is None:
        return Reference("supply", name, UNKNOWN, "声明里没有这台供给")
    if not supply.usable:
        return Reference("supply", name, OFFLINE, supply.detail)
    return Reference("supply", name, RESOLVABLE)


def _provider(name: str, registry: Registry) -> Reference:
    provider = registry.providers.get(name)
    if provider is None:
        return Reference("provider", name, UNKNOWN, "声明里没有这家供应商")
    if not provider.enabled:
        return Reference("provider", name, OFFLINE, "它被停用了")
    return Reference("provider", name, RESOLVABLE)


def _schedule(name: str, registry: Registry) -> Reference:
    schedule = registry.schedules.get(name)
    if schedule is None:
        return Reference("schedule", name, UNKNOWN, "声明里没有这条日程")
    if not schedule.enabled:
        return Reference("schedule", name, OFFLINE, "它被停用了")
    return Reference("schedule", name, RESOLVABLE)


_RESOLVERS = {
    "executor": _executor,
    "supply": _supply,
    "provider": _provider,
    "schedule": _schedule,
}
