"""`executors` 条目 → 执行者定义。**智能体也走这条**。

## 两种来源，同一个列表

| | 怎么写 | 是什么 |
| --- | --- | --- |
| **自己带代码** | `worker: {entrypoint: "worker.py:worker_entry"}` | 一段 worker |
| **基于另一个** | `executor: langgraph.agent` + `model:` / `prompt:` / `tools_from:` | **配置后的执行者** |

**智能体不是另一个范畴——它就是"配置后的执行者"。** 所以 Task 引用的永远是执行者：
可能是裸的（`weather`），也可能是配置过的（`ops-readonly`）。

**一段代码被多个配置用**：那个 LLM 循环只有一份，好几个配置基于它，各有各的 prompt
和模型。**执行者一个字都不用改。**

（这也正是当年逼出 `extends` 的那件事——现在它不是"两个包之间借实现"，
而是"**我这个执行者基于那个执行者**"，说人话。）

## `needs_llm` 与 `model`

**`needs_llm` 是"要模型"的声明，长在带代码的那个执行者上；`model` 是"用哪个模型"，
长在配置上。** 基于一个 `needs_llm` 的执行者，`model` 就是**必填**。

没有这条，"缺了模型"是**静默**的——跑到一半才发现没模型。有了它，在**扫描期**就被拒
（那条老规矩：能被登记的，就一定被校验过）。

## 一个包可以有几条执行者，名字写全名

**没有"一包一个"这条规则。** 一个包有 2 个硬编码函数，那就是 2 条。

**名字写全名**（`weather.collect`），不写短名（`collect`）：短名重复率高、也看不出是谁的。
一条的时候，全名通常就是包名。**全名在扫描期判唯一**——跟包名一个层级。

**`deepseek` 当年错在哪**：它也有两条，**但两条的区别是模型名**。错的不是"一包两条"，
是**一个本该是配置的维度被抬成了身份**——于是"换模型"变成"换执行者"，Task 上的引用
跟着变、checkpoint namespace 跟着变。

**模型现在在配置里选**（上一节的 `model:`），所以那个错误不可能再犯。同步脚本从
"改包的结构"降级成"填供应商的模型目录"（`extensions/_providers/`）。

## 参数分三类，别混

| 类 | 谁定 |
| --- | --- |
| **身份**（供应商 / `base_url` / `api_key_env`） | **供应商**那份声明 |
| **模型的事实**（上下文长度 / 支不支持工具调用） | 跟供应商的 `models[]` 走——**这是事实，不是配置** |
| **旋钮**（temperature / max_tokens / timeout） | 配置给默认，**在配置里改** |

**旋钮写一份声明**（`parameters`，带 `default` / `min` / `max` / `label`），界面和 worker
各取所需。今天 `defaults` 写一遍默认值、`allowed_parameters` 再写一遍范围——同一件事
写两遍，那一大坨删掉。

### 「声明」和「改值」用**形状**分开，不靠猜

```yaml
# 基座：说清这个旋钮是什么        # 配置：只改默认值
parameters:                         parameters:
  temperature:                        temperature: 0.6
    {type: number, default: 0.2,      # ← 标量就是"把默认值改成这个"，
     min: 0, max: 2, label: 温度}     #    范围和标签还是基座说的
```

**值是对象 → 它是一份声明；值是标量 → 它是在改默认值。** 两条规则各一种写法，
不需要上下文才知道怎么读。

**Task 创建时不提供旋钮输入。** 系统的用法是**先调配置、再建 Task**——所以旋钮的调整
发生在**配置层**，不在创建那一步。

**合并发生在装配期，worker 收终值**——它不知道"有默认值这回事"，也不需要知道。

## adapter：结果和审计的查询口

**结果归执行者的包**（内核只存 `result_ref`，ADR-008）。要让人查得到，包提供一个：

```python
def get_adapter(config, database_path) -> Adapter: ...

class Adapter(Protocol):
    def checkpoint_exists(self, task, checkpoint_ref, database_path) -> bool: ...
    def read_result(self, task, database_path) -> dict[str, Any]: ...
    def read_audit(self, task, database_path) -> dict[str, Any]: ...   # 可选
```

**它不参与启动，纯读。** 约定：`adapter.py` 摆在 `worker.py` 旁边，存在就自动认。

**不提供它的**，结果就是短命的——跑完在宿主内存里，重启就没了。**那是包的选择**：
内核凭什么替一个它不认识的执行者决定结果存哪、存多久？

**迁移时一起修的三个毛病**（旧代码里已经存在）：`database_path` 传两遍、`config` 收下
就丢、`read_audit` 用 `hasattr` 判而另两个不判（缺方法要在**加载时**拒绝，不是调用现场才炸）。

**这里怎么修的**：`checkpoint_exists` 和 `read_result` **必须有**，缺一个当场
抛（`open_adapter`）；`read_audit` 确实可选，调用方自己 `getattr` 判一次就行——
不再为它加一格定义字段（那一格没有读者）。

← 来自 extensions/executor_loader.py（`SUPPORTED_EXECUTOR_TYPES` / `executor_type` 已删）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .manifest import Executor as Declaration
from .manifest import Package
from .runtime import load_entrypoint

#: 一个 adapter **必须**有的两个方法。`read_audit` 不在这里——它确实可选。
REQUIRED_ADAPTER_METHODS = ("checkpoint_exists", "read_result")

#: 可选的那个。有就记下来，没有就记没有——但**只问一次**。
OPTIONAL_ADAPTER_METHODS = ("read_audit",)


@dataclass(frozen=True)
class Worker:
    """一段**要跑在子进程里**的代码。

    所以这里只有路径和名字，**没有函数对象**——跨进程边界不递函数。
    """

    entrypoint: str
    package: str
    root: str
    adapter_path: str = ""

    @property
    def file(self) -> str:
        return self.entrypoint.rsplit(":", 1)[0]

    @property
    def function(self) -> str:
        return self.entrypoint.rsplit(":", 1)[1]


@dataclass(frozen=True)
class ExecutorDefinition:
    """一个执行者**是什么**。登记进 `gateway/directory/executors.py` 的是它。

    `worker` 是空的，说明这条定义只是"配置"，真正要跑的代码来自 `based_on` 那一条——
    **解析在加载期就做完了**，所以到了运行期只有一个形状。
    """

    name: str
    package: str
    worker: Worker | None = None
    #: 开不开：**包那一行 × 它自己那一行**（包是总闸）。
    enabled: bool = True
    #: 起不来的原因。**空串 = 它没毛病**（能不能跑还要看有没有代码、有没有模型）。
    problem: str = ""
    needs_llm: bool = False
    based_on: str = ""
    model: dict[str, Any] | None = None
    prompt: dict[str, Any] | None = None
    parameters: dict[str, Any] = field(default_factory=dict)
    tools_from: tuple[str, ...] = ()
    tighten: tuple[str, ...] = ()

    @property
    def is_configured(self) -> bool:
        """**配置后的执行者**——人话叫智能体。"""
        return bool(self.based_on)

    @property
    def runnable(self) -> bool:
        """**它现在能不能被起起来。** 三件事都要成立：开着、没毛病、有代码（要模型的话有模型）。"""
        if not self.enabled or self.problem or self.worker is None:
            return False
        return bool(self.model) if self.needs_llm else True

    @property
    def why_not(self) -> str:
        """跑不了的原因——**说给人听的那一句**。"""
        if not self.enabled:
            return f"{self.name} 关着"
        if self.problem:
            return self.problem
        if self.worker is None:
            return f"{self.name} 没有可以跑的代码"
        if self.needs_llm and not self.model:
            return f"{self.name} 要用模型，但没有人给它配一个"
        return ""


# ── 两种来源

def own(entry: Declaration, package: Package, package_dir: Path) -> ExecutorDefinition:
    """自己带代码的那种。

    `model` / `prompt` 也照收：**带代码的那个也可以自己声明**（一个只伺候一家的
    执行者没必要再套一层配置）。基座不写 `model` 是常态——那是给配置留的位置。
    """
    worker = resolve_worker(entry, package, package_dir)
    return ExecutorDefinition(
        name=entry.name,
        package=package.id,
        worker=worker,
        enabled=bool(package.enabled and entry.enabled),
        needs_llm=bool(entry.needs_llm),
        model=dict(entry.model) if entry.model else None,
        prompt=dict(entry.prompt) if entry.prompt else None,
        parameters=dict(entry.parameters),
        tools_from=tuple(entry.tools_from),
        tighten=tuple(entry.tighten),
    )


def configured(entry: Declaration, package: Package,
               base: ExecutorDefinition) -> ExecutorDefinition:
    """基于另一个的那种：**继承它的代码，覆盖它的配置。**

    没有这条 `executor:` 的解析，"基于另一个执行者"就只是个说法——
    真正要跑的那段代码来自 `base`。
    """
    if base.is_configured:
        # 链式继承要处理环、处理顺序、处理"改一层动一串"。而这里想解决的问题
        # （一段代码好几个配置）一步就够——**先只有一层**。
        raise ValueError(f"{entry.name} 基于的 {base.name} 本身也是配置——只能基于带代码的执行者")
    return ExecutorDefinition(
        name=entry.name,
        package=package.id,
        worker=base.worker,
        enabled=bool(package.enabled and entry.enabled),
        needs_llm=base.needs_llm,
        based_on=base.name,
        model=dict(entry.model) if entry.model else base.model,
        prompt=dict(entry.prompt) if entry.prompt else base.prompt,
        parameters=merge_parameters(base.parameters, entry.parameters),
        tools_from=tuple(entry.tools_from),
        tighten=tuple(entry.tighten),
    )


def broken(entry: Declaration, package: Package, reason: str) -> ExecutorDefinition:
    """**登记但起不来。**

    声明里有它，所以它**必须在列表里**（"禁用的东西也要登记"是同一条）——只是跑不了，
    而且要说得清为什么。丢掉它等于让"用户写了、写错了"从界面上消失。
    """
    return ExecutorDefinition(name=entry.name, package=package.id,
                              enabled=bool(package.enabled and entry.enabled),
                              based_on=entry.executor, problem=reason)


def check(definition: ExecutorDefinition) -> None:
    """登记之前必须成立的两条。**错了就在这里拒**，不留到运行期。

    **"要用模型"这条只看配置那一层。** 基座写 `needs_llm: true` 而不写 `model`
    是**它的常态**——`langgraph-agent` 那个 LLM 循环不知道用户要用哪家模型，
    模型是**配置**告诉它的（"一段代码被多个配置用"）。所以要拦的是
    **配置没给模型**：那才会跑到一半才发现。
    """
    if definition.worker is None:
        raise ValueError(f"{definition.name} 没有可以跑的代码")
    if definition.is_configured and definition.needs_llm and not definition.model:
        raise ValueError(
            f"{definition.name} 基于的 {definition.based_on} 要用模型，但没给——"
            f"给这条配置加一个 model（用哪个模型是**配置**的事）")


# ── 参数：声明与合并

def merge_parameters(declaration: dict[str, Any],
                     overrides: dict[str, Any]) -> dict[str, Any]:
    """把"改默认值"叠到"声明"上。

    **标量 = 改默认值；对象 = 一整份声明**（覆盖式替换）。两条规则各一种写法，
    读的时候不需要上下文。
    """
    merged = {name: dict(rule) if isinstance(rule, dict) else rule
              for name, rule in declaration.items()}
    for name, value in overrides.items():
        if isinstance(value, dict):
            merged[name] = dict(value)          # 整份替换：它就是新声明
        else:
            current = merged.get(name)
            if isinstance(current, dict):
                merged[name] = {**current, "default": value}
            else:
                merged[name] = {"default": value}
    return merged


def values_of(definition: ExecutorDefinition) -> dict[str, Any]:
    """**worker 收到的那份值。** 它不知道"有默认值这回事"，也不需要知道。

    只有写了 `default` 的旋钮才出现在这里——没有默认值的旋钮不是"漏了"，
    是这一版还没给它定过值（界面会显示成空，而不是显示一个编出来的 0）。
    """
    return {name: rule["default"] for name, rule in definition.parameters.items()
            if isinstance(rule, dict) and "default" in rule}


# ── 代码在哪

def resolve_worker(entry: Declaration, package: Package, package_dir: Path) -> Worker:
    """把 `worker: {entrypoint: "worker.py:worker_entry"}` 落成一段**能跑的代码**。

    入口必须在包目录里——这是"包能提供什么"的边界，越界就不是这个包提供的。
    """
    raw = entry.worker or {}
    entrypoint = str(raw.get("entrypoint") or "").strip()
    if not entrypoint:
        raise ValueError(f"{entry.name} 的 worker 缺少 entrypoint")
    if ":" not in entrypoint:
        raise ValueError(f"{entry.name} 的 worker.entrypoint 必须形如 文件.py:函数名")
    filename, function = entrypoint.rsplit(":", 1)
    if not function.isidentifier():
        raise ValueError(f"{entry.name} 的 worker 函数名不合法: {function}")
    source = (package_dir / filename).resolve()
    root = package_dir.resolve()
    if not source.is_file() or root not in source.parents:
        raise ValueError(f"{entry.name} 的 worker 入口必须位于包目录内: {filename}")
    adapter = (source.parent / "adapter.py").resolve()
    adapter_path = str(adapter) if adapter.is_file() and root in adapter.parents else ""
    return Worker(entrypoint=entrypoint, package=package.id, root=str(root),
                  adapter_path=adapter_path)


def open_adapter(worker: Worker, config: dict[str, Any], database_path: str) -> Any | None:
    """把这个执行者的 adapter 取回来，**顺手验一遍它的契约**。

    没有 adapter 就返回 `None`——**结果就是短命的**（跑完在宿主内存里，重启就没了）。
    那是包的选择：内核凭什么替一个它不认识的执行者决定结果存哪、存多久。

    `checkpoint_exists` / `read_result` 缺一个就抛：**缺方法要在用之前就知道**，
    而不是等到人已经在看界面了才炸。`read_audit` 确实可选，所以只探不拦。

    （它**没法在加载期做**：`get_adapter(config, database_path)` 要运行期的库路径，
    而加载期还没有它。这是那条"加载时拒绝"的代价，记在 `OPEN_ISSUES.md` 里。）
    """
    if not worker.adapter_path:
        return None
    factory = load_entrypoint(Path(worker.adapter_path).parent,
                              f"{Path(worker.adapter_path).name}:get_adapter")
    if not callable(factory):
        raise ValueError(f"{worker.package} 的 adapter 没有 get_adapter")
    adapter = factory(config, database_path)
    missing = [name for name in REQUIRED_ADAPTER_METHODS
               if not callable(getattr(adapter, name, None))]
    if missing:
        raise ValueError(f"{worker.package} 的 adapter 缺少必须的方法: {' · '.join(missing)}")
    return adapter
