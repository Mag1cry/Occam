"""两段式加载：先扫描全部清单（不 import 任何东西），再决定加载谁。

**扫描 = 登记，加载 = 可用。** 扫描走遍 `extensions/` 下所有目录，**包括禁用的**，
因为禁用的东西也要占住自己的名字。加载只处理传进来的那些。

**一个加载器，不是三个。** 它读同一份清单，把每一条按 `type` 交给对应的装配
（`tools` / `executors` / `schedules`）。旧代码按包类型分成 capability / executor /
ability 三条路，而其中两条规则（"capability 不能有 executors"、"executor 不能有 tools"）
是编出来的——`weather` 两个都有。类型没了，三条路就成了一条。

**扫描期能判的，全部在这里判完**：清单形状、必填项、包名撞名。这些都是不用跑代码
就能读到的（契约表见 `manifest.py`）。剩下的——工具名撞名、连不上服务器——只能等加载。

撞名检查必须在 import **之前**做完：如果先 import 再发现撞名，那个包的代码已经进了
宿主进程，"禁用"就无从谈起。

## 扫描不 import，所以它读得动坏包

一个包的清单写坏了，扫描期只记一条诊断就往下走——**别的包照常**。
这正是"一个语法错误毁掉整个包"那条要防的事：毁掉的是**那一个**包。

## 「基于另一个执行者」要等到全部扫完

`executor: langgraph.agent` 指向的是**另一条**执行者，而它可能在这条之后才被读到。
所以加载分两趟：

```text
第一趟：自己带代码的（worker）——它们不依赖别人
第二趟：基于另一个的（executor）——这时候基座都已经在了
```

**指不到基座的就丢掉并记一条诊断**，而不是留一条半成品——半成品会在运行期
以"这个执行者的 worker 是空的"这种形式炸出来，而那时候离原因已经很远了。

← 来自 extensions/loader.py（按 type 分派的三条路已合流）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import executors as executors_module
from .diagnostics import Diagnostic
from .manifest import (
    Package, Provider, Schedule, Tool, conflicting, read_manifest, read_provider,
    read_schedule,
)
from .mcp_client import DEFAULT_TIMEOUT
from .channels import load_channel
from .tools import Supply, ToolImplementation, load_supply

#: 两条独立声明住的地方。**下划线开头**是给它们的名字——它们不是包。
SCHEDULES_DIR = "_schedules"
PROVIDERS_DIR = "_providers"

MANIFEST_NAME = "manifest.yaml"


@dataclass(frozen=True)
class ScanResult:
    """**扫描看到了什么。** 只读声明，一行代码都没跑。"""

    packages: tuple[Package, ...] = ()
    schedules: tuple[Schedule, ...] = ()
    providers: tuple[Provider, ...] = ()
    diagnostics: tuple[Diagnostic, ...] = ()

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(package.id for package in self.packages)

    def package(self, package_id: str) -> Package | None:
        for package in self.packages:
            if package.id == package_id:
                return package
        return None


@dataclass(frozen=True)
class SuppliedTool:
    """**加载出来了的一个工具**：它是谁声明的 + 它的实现在哪。

    两者分开是故意的：声明回答"要不要人批、谁允许调"，实现回答"怎么跑"。
    把它们揉成一个东西，判决就会被实现牵着走。
    """

    declaration: Tool
    package: str
    implementation: ToolImplementation


@dataclass(frozen=True)
class Loaded:
    """**加载完了的结果。** 谁把它登记进那四个列表由装配决定——`extensions/` 不拥有列表。

    **它连关着的包一起给。** "关着的也要登记"（前后端用同一份事实）落在这里：
    `packages` 是**扫描**到的全部（含 `enabled: false`），而 `tools` / `executors`
    是**加载成功**的那些。前端照着它渲染，关着的那个照常出现、只是点不动——
    它不用自己另编一套"关着的扩展"的概念。

    代价要认：**关着的包只有名字，没有工具清单**——工具是问出来的，而它没被加载。
    """

    packages: tuple[Package, ...] = ()
    tools: tuple[SuppliedTool, ...] = ()
    executors: tuple[executors_module.ExecutorDefinition, ...] = ()
    providers: tuple[Provider, ...] = ()
    schedules: tuple[Schedule, ...] = ()
    diagnostics: tuple[Diagnostic, ...] = ()
    supplies: tuple[Supply, ...] = field(default=(), repr=False)
    #: 起了的消息通道（`extensions/channels.py`）。**放在最后**：构造处按位置传，
    #: 插在中间就会静默错位（刚刚就这么错过一次）。
    channels: tuple[Any, ...] = ()

    @property
    def package_ids(self) -> tuple[str, ...]:
        return tuple(sorted({package.id for package in self.packages}))

    @property
    def disabled_ids(self) -> tuple[str, ...]:
        return tuple(sorted(package.id for package in self.packages if not package.enabled))

    def close(self) -> None:
        """把这一批供给全收掉。**重新识别前必须调它**，否则旧的单例还活着。"""
        for supply in self.supplies:
            supply.close()


class ExtensionLoader:
    """扫描 + 加载。**读，不写**——写是 `writer.py` 一个人的事。"""

    def __init__(self, root: Path, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.root = Path(root)
        self.timeout = timeout

    # ── 第一段：扫描

    def scan(self) -> ScanResult:
        packages: list[Package] = []
        diagnostics: list[Diagnostic] = []

        for directory in self._package_dirs():
            try:
                packages.append(read_manifest(directory))
            except ValueError as exc:
                # 读不出清单的包**不进列表**——它连自己叫什么都没说清。
                diagnostics.append(Diagnostic(directory.name, str(directory), "scan", str(exc)))

        for bad in conflicting(packages, [], []):
            diagnostics.append(bad)
            packages = [package for package in packages if package.path != bad.path]

        schedules, schedule_diagnostics = self._read_all(SCHEDULES_DIR, read_schedule)
        providers, provider_diagnostics = self._read_all(PROVIDERS_DIR, read_provider)
        diagnostics.extend(schedule_diagnostics)
        diagnostics.extend(provider_diagnostics)
        diagnostics.extend(conflicting(packages, schedules, providers))

        return ScanResult(tuple(packages), tuple(schedules), tuple(providers), tuple(diagnostics))

    def _package_dirs(self) -> list[Path]:
        """哪些目录是包。**按名字排序**——结论稳定，不看文件系统的脸色。"""
        if not self.root.is_dir():
            return []
        return [child for child in sorted(self.root.iterdir())
                if child.is_dir() and not child.name.startswith("_")
                and (child / MANIFEST_NAME).is_file()]

    def _read_all(self, dirname: str, reader) -> tuple[list, list[Diagnostic]]:
        directory = self.root / dirname
        items: list = []
        diagnostics: list[Diagnostic] = []
        if not directory.is_dir():
            return items, diagnostics
        for path in sorted(directory.glob("*.yaml")):
            try:
                items.append(reader(path))
            except ValueError as exc:
                diagnostics.append(Diagnostic(path.stem, str(path), "scan", str(exc)))
        return items, diagnostics

    # ── 第二段：加载

    def load(self, scan: ScanResult) -> Loaded:
        """**全局两趟**：先所有"自己带代码"的，再所有"基于别人"的。

        不能一个包一个包地走——基座**可能在后一个包里**（`ops` 基于 `weather.collect`，
        而 `ops` 按名字排在前头）。一趟一趟地按包走，跨包继承就会读成"基座不存在"。
        """
        diagnostics = list(scan.diagnostics)
        supplies: list[Supply] = []
        tools: list[SuppliedTool] = []
        channels: list[Any] = []
        executors: list[executors_module.ExecutorDefinition] = []

        for package in scan.packages:
            directory = Path(package.path)
            if package.enabled:
                # **只有开着的包才 import 代码**（ADR-029）。关着的那几台供给仍然登记，
                # 只是没有函数名——见下。
                for declaration in package.tools:
                    if not declaration.enabled:
                        continue
                    tools, supplies = self._load_tool(
                        package, directory, declaration, tools, supplies, diagnostics)

        # 通道：**宿主的手**，和工具一样是包内入口（一个类实例管一个包）。
        # 一条起不来只记一条诊断——它不该拖垮别的包（同 `_load_tool`）。
        #
        # **关着的包连通道都不建**，和工具那一趟同一条规矩（`package.enabled` 那里）。
        # 这条漏过一次，代价很具体：`enabled: false` 只挡住了工具，通道照建——而通道
        # 不是"一个被允许的动作"，它是**宿主自己的手**：一条长连接、一份凭据，而且是
        # **独占资源**（同一应用多条连接互相吃事件）。"我把它禁了"必须是字面意思。
        for package in scan.packages:
            if not package.enabled:
                continue
            for declaration in package.channels:
                if not declaration.enabled:
                    continue
                try:
                    channels.append(load_channel(Path(package.path), declaration))
                except Exception as exc:        # noqa: BLE001 — 见上
                    diagnostics.append(Diagnostic(package.id, str(package.path),
                                                  "load", str(exc), imported=True))

        # 第一趟：自己带代码的。**它不依赖别人**，所以关着的包的条目也能一起登记
        # （解析 worker 入口只是拼路径，不 import 任何东西）。
        for package in scan.packages:
            executors.extend(
                self._own_executors(package, Path(package.path), diagnostics))

        # 第二趟：基于另一个的——这时候**所有**基座都已经在了。
        for package in scan.packages:
            executors.extend(
                self._based_executors(package, Path(package.path), executors, diagnostics))

        # **关键字传**：位置传错一个不会报错，只会把一份东西悄悄塞进别的字段
        # （刚刚 real 发生在 `channels` 上：一半的测试报 `'Supply' 没有某个属性`）。
        return Loaded(packages=tuple(scan.packages), tools=tuple(tools),
                      executors=tuple(executors), providers=tuple(scan.providers),
                      schedules=tuple(scan.schedules), diagnostics=tuple(diagnostics),
                      supplies=tuple(supplies), channels=tuple(channels))

    def _load_tool(self, package: Package, directory: Path, declaration: Tool,
                   tools: list[SuppliedTool], supplies: list[Supply],
                   diagnostics: list[Diagnostic]) -> tuple[list[SuppliedTool], list[Supply]]:
        try:
            supply = load_supply(directory, declaration, timeout=self.timeout)
        except Exception as exc:
            # **一台起不来不连累别的**——记一条诊断，接着走。半建的资源由
            # `load_supply` 自己先收掉（它才知道自己建了什么）。
            #
            # 只接 `Exception`：真·进程级中断（Ctrl-C、`SystemExit`）照常往上走，
            # 那时候"接着加载别的包"不是你想要的事。
            #
            # `imported` 说的是"这段代码进宿主进程了吗"，用户靠它决定下一步：
            # 包内那种**会真的 import 它**（于是要重启才彻底卸干净）；
            # 外面那种只发了一次 HTTP，宿主进程里什么都没多。
            diagnostics.append(Diagnostic(package.id, str(directory), "load", str(exc),
                                          imported=not declaration.is_external))
            return tools, supplies
        supplies.append(supply)
        tools.extend(SuppliedTool(declaration, package.id, implementation)
                     for implementation in supply.tools)
        return tools, supplies

    def _own_executors(self, package: Package, directory: Path,
                       diagnostics: list[Diagnostic]) -> list[executors_module.ExecutorDefinition]:
        """**自己带代码的那些。** 每一条声明的执行者都交出去——开着的、关着的、起不来的。

        起不来的那条**不丢**：它在声明里写过（"禁用的东西也要登记"是同一条道理），
        丢掉等于让"用户写了、写错了"从界面上消失。它的 `problem` 就是它为什么跑不了。
        """
        found = []
        for entry in package.executors:
            if entry.executor:
                continue
            found.append(self._build(entry, package, directory, diagnostics,
                                     lambda: executors_module.own(entry, package, directory)))
        return found

    def _based_executors(self, package: Package, directory: Path,
                         known: list[executors_module.ExecutorDefinition],
                         diagnostics: list[Diagnostic]) -> list[executors_module.ExecutorDefinition]:
        """**基于另一个的那些。** 基座不在了也登记，只是跑不了。"""
        bases = {item.name: item for item in known}
        found = []
        for entry in package.executors:
            if not entry.executor:
                continue
            base = bases.get(entry.executor)
            if base is None or not base.enabled or base.problem:
                # **基座不在了**：它可能名字写错了，也可能那个包关着／起不来。
                reason = (f"{entry.name} 基于的 {entry.executor} 不可用——"
                          f"名字写错了，或者它在的包关着")
                if package.enabled:
                    diagnostics.append(Diagnostic(package.id, str(directory), "load", reason))
                    found.append(executors_module.broken(entry, package, reason))
                else:
                    found.append(executors_module.ExecutorDefinition(
                        name=entry.name, package=package.id, enabled=False,
                        based_on=entry.executor))
                continue
            found.append(self._build(entry, package, directory, diagnostics,
                                     lambda: executors_module.configured(entry, package, base)))
        return found

    def _build(self, entry: Tool, package: Package, directory: Path,
               diagnostics: list[Diagnostic], make) -> executors_module.ExecutorDefinition:
        try:
            definition = make()
            if package.enabled:
                # **关着的包不判"能不能跑"**：它现在就是不该跑，而不是它坏了。
                executors_module.check(definition)
        except Exception as exc:                  # noqa: BLE001 — 起不来也要登记
            diagnostics.append(Diagnostic(package.id, str(directory), "load", str(exc)))
            return executors_module.broken(entry, package, str(exc))
        return definition
