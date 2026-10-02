"""`tools` 条目 → 供给工具。两种供给，但**供给方对句柄没有发言权**。

## 外面那种：问它

`url: http://127.0.0.1:8931/mcp` —— 连接、`tools/list`、`tools/call` 全交给
`mcp_client.py`。**它没有"函数"这个概念，是个协议端点。**

## 包里那种：读它有哪些函数

`entrypoint: provider.py:Weather` —— **注册时实例化一次，成为一个单例**：

```python
class Weather:
    def __init__(self):
        self.config = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text())

    def current(self, city: str) -> dict: ...   # ← 一个工具
    def wind(self, city: str) -> dict: ...      # ← 另一个工具
```

**单例的函数就是工具，调用就是直接调那个函数。** 不走 MCP，不起进程，没有握手。
包的配置由**包自己读**——宿主不参与。

## 这一层交出去的是"实现"，不是"句柄"

工具**在系统里**长什么样——叫什么、要不要人批、谁允许调——归 `gateway/directory/`，
句柄从 gateway 发出去。**句柄如果由供给方递出来，谁拿到谁就能调，判决就被绕过了。**

所以这里没有"注册进目录"的语义，只有"**供给**"：包说自己有什么，gateway 决定
它在系统里是什么。包作者和 agent 作者看到的永远是"一堆函数"，进程和协议藏在后面。

## 哪些函数算工具

**公开的、可调用的**。四类不算：

| 不算 | 为什么 |
| --- | --- |
| `_` 开头的 | 私有——包作者用它藏内部实现，我们不替他决定暴露 |
| 类本身 | 它是个类型，不是动作 |
| `property` 之类 | 取值不是**调用**，模型"调"它没有意义 |
| dunder | `__init__` 是构造的一部分，`__eq__` 是语言协议——它们不是这个包对外做的事 |

## schema 从**函数签名**读出来

声明里**不写** `input_schema`——工具长什么样是供给方的事，写两遍就会漂移
（旧代码正是写两遍再断言两边相等）。

| 签名里有什么 | schema 里变成什么 |
| --- | --- |
| `str` / `int` / `float` / `bool` / `list` / `dict` | `string` / `integer` / `number` / `boolean` / `array` / `object` |
| 有默认值 | **不必填** |
| 没有默认值 | **必填** |
| `X | None` | 去掉 `None` 之后照上面映射 |
| 没写注解 / 认不出的类型 | 那一格留空（`{}` = 什么都行）——**这不是猜，是如实说"不知道"** |

函数的 docstring 第一行当描述（模型靠它选工具）。

**包里写了 `from __future__ import annotations` 也没关系。** 那一行会让所有注解变成
**字符串**（PEP 563），而它在包里很常见——所以签名里的字符串注解要**求值回真类型**
再映射。不求值的话，`city: str` 读到的是字符串 `"str"`，认不出，于是**整个 schema
全是空的**，而模型只能拿到一堆没有类型的参数。求不出来的（引用了不存在的名字）
才退回"不知道"。

## 实例化是**一次**的

单例在注册时建好，之后每次调用都是同一个对象。所以：

- 它在 `__init__` 里读配置、建连接池、开文件——**只做一次**
- **"禁用"就是销毁实例**——干净、可逆，比原来那个"卸载不彻底，要重启才干净"好得多

## 代价要认

包内实现**住在宿主进程里**，所以"工具代码永不进宿主进程"这条对包内供给不成立。
换来的是简单，而且**包内工具抛异常会直接冒到宿主**——这一层不吞它，
由 `gateway/function/` 那边的执行口去翻译（那里才知道该回给 Worker 什么形状）。

## 扫描期不知道有哪些工具

所以"禁用的包也占住名字"只到**包名**一层。工具名**不需要全局唯一**——它是
`服务器名.函数名`，复合键天生唯一。

启动要连所有启用的外部供给，而**"它没起"不是异常，是常态**——所以超时是必须的。

← 来自 extensions/capability_loader.py + mcp_runtime.py + abilities.py 的 MCPAbility / _MCPProvider
"""
from __future__ import annotations

import builtins
import inspect
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Any, Callable, get_args, get_origin, get_type_hints

from .mcp_client import DEFAULT_TIMEOUT, McpConnection, McpTool
from .manifest import Tool as Declaration
from .runtime import load_entrypoint

#: 注解 → JSON Schema 的类型表。**只有这一处**，别在别的地方再映射一遍。
TYPE_NAMES: dict[Any, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


@dataclass(frozen=True)
class ToolImplementation:
    """一台供给交出来的**一个**工具：叫什么、怎么描述、怎么调。

    `tool_id` 是**全名**（`weather.current`）——供给名 + 函数名，天生唯一。
    """

    tool_id: str
    description: str
    input_schema: dict[str, Any]
    invoke: Callable[[dict[str, Any]], Any]


class Supply:
    """一台供给：**工具清单 + 怎么收掉它**。

    它是"包说自己有什么"的结果，不是"系统里有什么"——后者归 gateway。

    **两种来源，同一个对象。** 外面那台和包里那个的差别，只在**构造它的那两段代码**
    里（一个连服务器、一个实例化单例）；到了这个对象上只剩"有哪些工具"和"怎么收"。
    给来源各留一个子类，等于让每个读它的人都得先分辨"我手上是哪一种"——而它们之后
    要做的事一模一样。

    `close()` 收两样：清单（放掉调用闭包，包内那个单例就没人引用了）和 `release`
    （外面那台要断开连接）。**包内不需要关闭钩子**——不额外发明一套卸载协议。
    """

    def __init__(self, tools: tuple[ToolImplementation, ...],
                 release: Callable[[], None] | None = None) -> None:
        self.tools = tuple(tools)
        self._release = release

    def close(self) -> None:
        """把这一台收掉。**禁用就是销毁实例**——收完可以重复调。"""
        self.tools = ()
        release, self._release = self._release, None
        if release is not None:
            release()


def load_supply(package_dir: Path, declaration: Declaration, *,
                timeout: float = DEFAULT_TIMEOUT) -> Supply:
    """读一条 `tools` 声明，把它的实现取回来。

    **失败就抛**——调用方拿异常去记一条诊断，别的包照常起来。
    """
    if declaration.url:
        return _load_external(declaration, timeout=timeout)
    return _load_internal(package_dir, declaration)


# ── 外面那种

def _load_external(declaration: Declaration, *, timeout: float) -> Supply:
    connection = McpConnection(declaration.url, timeout=timeout)
    try:
        connection.open()
        found = connection.list_tools()
    except Exception:
        # **半建的连接要先收掉再往上抛**：上面只会记一条诊断，看不见这个连接。
        connection.close()
        raise
    tools = tuple(
        ToolImplementation(
            tool_id=f"{declaration.name}.{item.name}",
            description=item.description,
            input_schema=item.input_schema,
            invoke=_external_invoker(connection, item),
        )
        for item in found
    )
    return Supply(tools, connection.close)


def _external_invoker(connection: McpConnection, item: McpTool) -> Callable[[dict[str, Any]], Any]:
    def invoke(arguments: dict[str, Any]) -> Any:
        return connection.call_tool(item.name, arguments)

    invoke.__doc__ = item.description
    return invoke


# ── 包里那种

def _load_internal(package_dir: Path, declaration: Declaration) -> Supply:
    target = load_entrypoint(package_dir, declaration.entrypoint)
    instance = target() if isinstance(target, type) else target
    found = public_functions(instance)
    if not found:
        # **一台一个工具都没有的供给，是作者写错了**——多半是函数全带了 `_` 前缀，
        # 或者入口指向了一个不是"装函数的对象"的东西。这时候安静地供出零个工具，
        # 界面上只会显示"这个包什么都没有"，而原因（哪一行写错了）就丢了。
        raise ValueError(
            f"{declaration.name} 的入口 {declaration.entrypoint} 里没有一个公开函数——"
            f"单例的公开方法才是工具（下划线开头的、property、dunder 都不算）")
    tools = tuple(
        ToolImplementation(
            tool_id=f"{declaration.name}.{name}",
            description=_describe(attribute),
            input_schema=schema_from_signature(attribute),
            invoke=_internal_invoker(attribute),
        )
        for name, attribute in found
    )
    return Supply(tools)


def _internal_invoker(function: Callable[..., Any]) -> Callable[[dict[str, Any]], Any]:
    def invoke(arguments: dict[str, Any]) -> Any:
        return function(**(arguments or {}))

    invoke.__doc__ = function.__doc__
    return invoke


def public_functions(instance: Any) -> list[tuple[str, Callable[..., Any]]]:
    """单例身上**算工具**的那些函数，按名字排序（结论稳定，不看 `dir()` 的脸色）。

    哪四类不算，见文件头那张表——**规则只有这一处**。
    """
    found: list[tuple[str, Callable[..., Any]]] = []
    for name in sorted(dir(instance)):
        if name.startswith("_"):
            continue
        attribute = getattr(instance, name)
        if isinstance(attribute, type) or not callable(attribute):
            continue
        if _is_property_like(instance, name):
            continue
        found.append((name, attribute))
    return found


def _is_property_like(instance: Any, name: str) -> bool:
    """类上是不是 `property` / `cached_property`——取值不是调用，模型"调"它没意义。"""
    for klass in type(instance).__mro__:
        if name in vars(klass):
            return isinstance(vars(klass)[name], (property, cached_property))
    return False


def schema_from_signature(function: Callable[..., Any]) -> dict[str, Any]:
    """**函数签名 → input_schema。规则只在这里。**

    这一格是给模型看的，所以它得说清"有哪些参数、哪个必填、什么类型"——
    但**不替包作者编**：认不出的类型留空，而不是猜一个 string。
    """
    properties: dict[str, Any] = {}
    required: list[str] = []
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):         # 内建函数之类，读不出签名
        return {"type": "object", "properties": {}, "required": []}

    hints = _hints_of(function)
    for name, parameter in signature.parameters.items():
        if name == "self" or parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        schema = _schema_of(hints.get(name, inspect.Parameter.empty))
        if parameter.default is not inspect.Parameter.empty:
            schema = {**schema, "default": _plain(parameter.default)}
        else:
            required.append(name)
        properties[name] = schema
    return {"type": "object", "properties": properties, "required": required}


def _hints_of(function: Callable[..., Any]) -> dict[str, Any]:
    """把注解求值成真的类型——**因为包作者写的很可能是字符串**。

    `from __future__ import annotations` 一写，**所有注解都变成字符串**（PEP 563），
    而那一行在包里很常见。求值这件事交给标准库（`typing.get_type_hints`），
    不再自己 `eval`。

    **但它是一条绳上的**：一个名字解析不出来，整批注解一起失败。而"那几个能解析的"
    不该跟着一起变成不知道——所以失败时退回逐条求值，能解析的仍然算数。
    """
    try:
        return get_type_hints(function)
    except Exception:                       # noqa: BLE001 — 逐条来
        return _hints_one_by_one(function)


def _hints_one_by_one(function: Callable[..., Any]) -> dict[str, Any]:
    """一条一条求值：解析不出来的那条**就当它没写**，不动别人。"""
    module = inspect.getmodule(function)
    scope = {**vars(builtins), **(vars(module) if module is not None else {})}
    hints: dict[str, Any] = {}
    for name, parameter in _parameters_of(function).items():
        annotation = parameter.annotation
        if not isinstance(annotation, str):
            hints[name] = annotation
            continue
        try:
            hints[name] = eval(annotation, scope)        # noqa: S307 — 只求值注解
        except Exception:                                # noqa: BLE001 — 如实说不知道
            continue
    return hints


def _parameters_of(function: Callable[..., Any]) -> dict[str, inspect.Parameter]:
    try:
        return dict(inspect.signature(function).parameters)
    except (TypeError, ValueError):
        return {}


def _schema_of(annotation: Any) -> dict[str, Any]:
    if annotation is inspect.Parameter.empty:
        return {}                            # 如实说"不知道"，不是猜
    if annotation is None or annotation is type(None):
        return {"type": "null"}
    origin = get_origin(annotation)
    if origin is not None:
        # `X | None` / `Optional[X]`：去掉 None 之后看里面那个
        args = [item for item in get_args(annotation) if item is not type(None)]
        if len(args) == 1:
            return _schema_of(args[0])
        return {}                            # Union 说不清是哪种，留空
    if isinstance(annotation, type) and annotation in TYPE_NAMES:
        return {"type": TYPE_NAMES[annotation]}
    return {}


def _plain(value: Any) -> Any:
    """默认值要能进 JSON——放不进去的就当没有（它只是给模型的一个提示）。"""
    return value if isinstance(value, (str, int, float, bool, list, dict, type(None))) else None


def _describe(function: Callable[..., Any]) -> str:
    """描述取 docstring 的第一行——模型靠它选工具。"""
    doc = inspect.getdoc(function) or ""
    return doc.strip().splitlines()[0].strip() if doc.strip() else ""
