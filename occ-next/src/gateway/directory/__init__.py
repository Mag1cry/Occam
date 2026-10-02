"""四个列表：能力、执行者、供应商、日程。启动时建，读声明的时候往里注册。

**它们不是四个抽象概念，就是四个列表**——各自一个文件，各自一个类。
"全局只有一份"这件事在**装配期**定死（`app/build.py`），不是靠 import 一个全局变量：
测试要一个干净的例子，而全局变量得手动清理，忘了就串味。

## 登记是**全量**的

声明里写了什么，列表里就有什么：开着的、关着的、起不来的，一视同仁。
**登记 ≠ 可用**——`enabled`、`loaded`、`problem` 三个事实跟着条目走，
"能不能用"是**读的时候算的**（`usable` / `runnable`）。

于是"关掉一个东西"改的只是声明里那一行，不需要重新算一遍登记；
"这个东西现在能不能用"也不需要第二个地方维护状态。

## 为什么日程也在里面

另外三个装的是**供给**（能调什么 / 谁负责推 / 模型在哪），日程是**触发**。
它照样要登记，因为**前端要渲染它们**——"列表是前端渲染的唯一依据"不能有例外，
一有例外，前端就得另编一套概念，于是同一件事又变成两处在说。

## 谁写、谁读

- **写**：只有加载期。`replace()` 收的是**完整的现在**（不是"这次改了哪几条"）——
  于是回滚就是把上一次那份再交一遍，不用维护一份会漂移的账。
- **读**：前端（渲染）、判决（能力 + 执行者）、`tasks/`（起 worker、派发）。
- **不做判决、不拥有句柄、内核不读它。**

← 来自 composition/registry.py
"""
from __future__ import annotations

from dataclasses import dataclass

from ...extensions.loader import Loaded
from .capabilities import CapabilityDirectory, Supply, from_loaded
from .capability_view import CapabilityView
from .executors import ExecutorDirectory
from .providers import ProviderDirectory
from .schedules import ScheduleDirectory

__all__ = ["Registry", "CapabilityDirectory", "CapabilityView", "ExecutorDirectory",
           "ProviderDirectory", "ScheduleDirectory", "PackageRecord", "Supply"]


@dataclass(frozen=True)
class PackageRecord:
    """**包层**那几行（`id` / `enabled` / `name` / 说明）。

    它登记在这里，是因为**有两条问题只有它答得出来**：一个包一条条目都没声明时它还在不在，
    以及"关着的"是包的开关还是条目的开关——条目上那一格是两者相与之后的**结果**。
    """

    id: str
    enabled: bool = True
    name: str = ""
    description: str = ""
    version: str = ""
    #: 这个包的**目录**。配置舱要按文件组织，而"它在哪儿"只有扫描期知道。
    path: str = ""


class Registry:
    """四个列表 + 包层，一次替换。**它是加载期的写入面**（`extensions.hotload.Registrar`）。

    供给（能调的那些实现）**不在这里**——它们在 `function/providers.py`。
    """

    def __init__(self) -> None:
        self.packages: tuple[PackageRecord, ...] = ()
        self.capabilities = CapabilityDirectory()
        self.executors = ExecutorDirectory()
        self.providers = ProviderDirectory()
        self.schedules = ScheduleDirectory()
        #: 按执行者看能力的那个视图。**不是第五个列表**，是一次查询（见它自己的说明）。
        self.view = CapabilityView(self.capabilities, self.executors)

    def replace(self, loaded: Loaded) -> None:
        self.packages = tuple(PackageRecord(id=package.id, enabled=package.enabled,
                                            name=package.name, description=package.description,
                                            version=package.version, path=package.path)
                              for package in loaded.packages)
        self.capabilities.replace(from_loaded(loaded))
        self.executors.replace(loaded.executors)
        self.providers.replace(loaded.providers)
        self.schedules.replace(loaded.schedules)

    def executor_config(self, definition) -> dict:
        """起一个执行者时要交给它的那份**终值**：模型解析过、旋钮合并过、**工具清单列全**。

        **起 worker 和读结果用的是同一份**——两处各拼一份，迟早不一样，
        而那时候"界面读出来的"和"它当时跑的"就是两个东西了。

        `tools` 是**它看得见的那些工具**（名字 + 描述 + schema，数据不是句柄）。
        没有这一格，一个 LLM 执行者只能瞎猜工具名——而"我们给它什么它才有什么"
        正是进程边界上唯一的那道事实（`function/ports.py`）。
        """
        from ...extensions.executors import values_of

        return {
            "model": self.providers.resolve(definition.model) if definition.model else {},
            "prompt": dict(definition.prompt or {}),
            "parameters": values_of(definition),
            "package": definition.package,
            "tools": [{"name": spec.name, "description": spec.description,
                       "input_schema": spec.input_schema}
                      for spec in self.view.visible_to(definition.name)],
        }

    def package(self, package_id: str) -> PackageRecord | None:
        for item in self.packages:
            if item.id == package_id:
                return item
        return None

    def package_enabled(self, package_id: str) -> bool:
        found = self.package(package_id)
        return bool(found and found.enabled)
