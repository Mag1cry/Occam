"""**能力列表**：有哪些供给、各自挂着哪些工具。

**它就是一个列表。** 启动时建，读声明的时候往里注册，要用到的时候直接取。
外面一台 MCP 服务器和包里一个对象，进了这个列表之后长得一样——判决和执行看不出区别。

## 全量登记：**每条 `tools` 声明都在这里**

开着的、关着的、起不来的，一视同仁——**登记 ≠ 可用**。三个事实分开记，各有各的用处：

| 记什么 | 谁写的 | 谁看 |
| --- | --- | --- |
| `enabled`（包那一行 × 条目那一行） | 声明 | 配置舱（"这台关着"） |
| `loaded` / `problem`（取回来没有、为什么没有） | 这一次加载 | 诊断、运维 |
| `tools`（函数名 + schema） | 供给方（问出来的） | 判决、模型、前端 |

**"能不能用"是读的时候算的**（`usable`），不是注册时写死的一个状态——所以
"关掉它"和"启用它"都不需要重新算一遍登记，改的只是声明里那一行。

## 工具清单是**问出来的**，所以关着的只有名字

一个包的函数名要跑起来才知道（问服务器，或读单例有哪些函数）。所以关着的那台：
`enabled=false`、`loaded=false`、`tools=()`——**只有名字和审批**。这是那笔代价的落点
（`extensions/README.md` 的"关着的包只有名字，没有工具清单"）。

因此"这个工具在不在"有三级的答案，`CapabilityView` 把它们说全：
供给在不在 → 它现在能不能用 → 那台供给里有没有这个函数。

## 不拥有句柄

列表里只有名字、描述、schema——**能调的那个东西在 `function/providers.py`**。
递出去给 worker 的永远是 `ToolSpec`（数据）。

← 来自 abilities.py 的 AbilityRegistry（Ability / StaticAbility / ProviderAbility 已删——
  供给的样子不进这个列表）
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..function.ports import ToolSpec

READY = "ready"
OFFLINE = "offline"
FAILED = "failed"


@dataclass(frozen=True)
class Supply:
    """声明里的一条 `tools` 条目——**它是什么** + **它现在什么状态**。"""

    name: str
    package: str = ""
    approval_required: bool = True
    idempotency: str = "safe-retry"
    #: 包那一行 × 它自己那一行。包是总闸。
    enabled: bool = True
    #: 代码/连接取回来了吗。
    loaded: bool = False
    #: 起不来的原因（撞名、连不上、import 错）。**空串 = 它没毛病。**
    problem: str = ""
    #: 取回来了才有：函数名 + 描述 + schema。
    tools: tuple[ToolSpec, ...] = field(default_factory=tuple)

    @property
    def usable(self) -> bool:
        """**现在能不能用。** 读的时候算——没有"注册时写死"的状态。"""
        return self.enabled and self.loaded and not self.problem

    @property
    def status(self) -> str:
        if not self.enabled:
            return OFFLINE
        return READY if self.usable else FAILED

    @property
    def detail(self) -> str:
        """"为什么不能用"——**说给人听的那一句**。**能用的时候是空串。**

        这一格的名字就是"为什么不能用"，所以答一个不是原因的东西是有代价的：
        它会一路印到界面上（`snapshot` 每一台供给都带 `detail`，前端拿它当扩展
        节点的描述），于是**一台好好的供给挂着一句"它起不来"**。
        """
        if not self.enabled:
            return "它关着"
        if self.problem:
            return self.problem
        return "" if self.loaded else "它起不来"

    def tool(self, tool_id: str) -> ToolSpec | None:
        for spec in self.tools:
            if spec.name == tool_id:
                return spec
        return None


class CapabilityDirectory:
    def __init__(self) -> None:
        self._items: tuple[Supply, ...] = ()

    def replace(self, items: tuple[Supply, ...]) -> None:
        self._items = tuple(items)

    def all(self) -> tuple[Supply, ...]:
        return self._items

    def supply(self, name: str) -> Supply | None:
        for item in self._items:
            if item.name == name:
                return item
        return None

    def get(self, tool_id: str) -> Supply | None:
        """这个工具全名属于哪台供给。**找不到就是没有这台供给**——它可能连函数都没取回来。"""
        for item in self._items:
            if item.tool(tool_id) is not None or tool_id == item.name:
                return item
        return None


def from_loaded(loaded) -> tuple[Supply, ...]:
    """一次加载的结果 → 能力列表。**每条 `tools` 声明都登记，一条不落。**

    起不来的那条把原因带上（`problem`），而**原因只有这一次说得出来**——诊断不落库
    （ADR-028），重启之后"上次为什么没起来"就没了。
    """
    found: dict[tuple[str, str], list[ToolSpec]] = {}
    for item in loaded.tools:
        found.setdefault((item.package, item.declaration.name), []).append(
            ToolSpec(name=item.implementation.tool_id,
                     description=item.implementation.description,
                     input_schema=dict(item.implementation.input_schema)))
    failures = {bad.package: bad.message for bad in loaded.diagnostics if bad.stage == "load"}

    supplies: list[Supply] = []
    for package in loaded.packages:
        for declaration in package.tools:
            tools = tuple(found.get((package.id, declaration.name), ()))
            supplies.append(Supply(
                name=declaration.name,
                package=package.id,
                approval_required=declaration.approval_required,
                idempotency=declaration.idempotency,
                enabled=bool(package.enabled and declaration.enabled),
                loaded=bool(tools),
                problem="" if tools else failures.get(package.id, ""),
                tools=tools,
            ))
    return tuple(supplies)
