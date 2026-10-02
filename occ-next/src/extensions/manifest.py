"""契约表（`type → 必填项`）+ 清单的形状与校验。

manifest 是**一份注册清单**：每一条写明 `type`，而 `type` 决定它必须有哪几栏。

```python
REQUIRED = {
    "tools":     ("name", "approval_required"),      # url 或 entrypoint，恰好一个
    "executors": ("name",),                          # worker 或 executor，恰好一个
    "schedules": ("name", "cron"),
    "providers": ("name", "base_url", "api_key_env"),
    # 通道：**宿主的外围之手**，不是被审批的动作（它不走 `function/` 那条管线）。
    # 必填只有"它是谁"和"它在哪个文件里"——怎么送由它自己实现（契约见
    # `gateway/output/paths.py`）。
    "channels": ("name", "entrypoint"),
}
OPTIONAL = {
    "tools":     ("url", "entrypoint", "idempotency"),
    "executors": ("worker", "executor", "needs_llm", "model", "prompt",
                  "parameters", "tools_from", "tighten"),
    "schedules": ("timezone", "executor_ref", "task_ref"),
    "providers": ("models",),
    "channels": (),
}
```

**必填的判据**：缺了它注册器就必须拒绝，因为它猜不出来。可选 = 缺了能填一个**安全的**默认值。

`schedules` 的 `task_ref` 就在可选那一栏：缺了它**不是**一句写错的声明，而是
"这次运行没有正文"——`tasks/inputs.py::read` 的第一行就是 `if not task_ref: return ""`，
派发照常发生。把它列进必填会逼人编一个文件名出来，而那个文件一旦不存在，
**每一次派发都会被它拦下**（读不到正文就不起进程）——比留空糟得多。

**这张表就是今天散在三个加载器里的那些 `if`**（`capability` 包拒绝 `executors`、
`executor` 包拒绝 `tools`、`SUPPORTED_TYPES` 挡在门口）。收在一处之后，"一个包能不能
被登记"只有一个答案。

**所有必填项都在扫描期可校验**——不需要任何代码跑起来就能读到。所以"扫描 = 登记"是
完整的：能被登记的，就一定被校验过。

## `enabled` 是**每一条**都有的通用可选栏

四个 `type` 都有它，而且**包层也有一行**。它不进上面那张表，因为它的含义和别的栏不同：

**它不回答"这个东西长什么样"，只回答"这台机器上要不要用它"。**

所以"关掉一个东西"就是写这一行，而一份干净的清单里**本来就没有它**——
`extensions/writer.py` 为此把它列成"允许新增的唯一例外"。

## 不认识的键 = 拒绝

清单上出现契约表里没有的键，**直接拒**。理由和必填项一样：**能被登记的，就一定被校验过**。
放行一个不认识的键，就等于放行一次拼写错误——`approval_require` 少一个 `d`，
在"忽略未知键"的策略下会**静默**变成"没写这一栏"，而这一栏是必填的……

（顺带：这也是旧清单里 `target_type` / `risk_level` / `cancellable` / `function_name`
那五个零消费者字段消失的方式——它们现在是**未知键**，会被挡在门口。）

## 布尔声明只认布尔

`enabled` / `approval_required` / `needs_llm` 走同一把尺子：真布尔，或者明确列出的
那几种写法。**不用 `bool(value)`**——`"false"` 是个非空字符串，`bool("false")` 是**真**，
于是那一格写错一个引号，开关就静默地反了。认不出的当场拒（和"未知键"同一个理由：
能被登记的，就一定被校验过）。

## 撞名检查有三层，也全在扫描期

| 判什么 | 范围 |
| --- | --- |
| 包名（`id`） | 全部扫到的包 |
| 条目名（`tools.name` / `executors.name`） | **各自的类里**，写全名（`weather.collect`） |
| 工具的**全名**（`供给名.函数名`） | **不用判**——供给名已唯一，一台供给内的函数名天生唯一 |

**这三层的共同点：名字全在声明里，所以不用跑代码就能判。** 这就是"扫描 = 登记"
能完整的原因——**撞名从来不需要等加载**。

**没有"一个大命名空间"，每类各管各的**——**名字的含义由它的词条决定**：一家叫
`weather` 的供应商和一个叫 `weather` 的包是两回事。

**唯一跨类的是"工具全名"和"执行者名"的对上——那是故意的**：对上了就是同一个函数的
两个身份。**它不是撞名，是缝合。**

## 两处「恰好一个」

同一条规矩：**同一个东西不能用两种办法声明。**

| 条目 | 二选一 | 它们是什么 |
| --- | --- | --- |
| `tools` | `url` / `entrypoint` | **两种供给**：外面在跑的服务器，或包里一个对象 |
| `executors` | `worker` / `executor` | **自己带代码，还是基于另一个执行者** |

都不是 `kind` 复活——`kind` 当年区分的是"宿主实现还是包实现"，那是**两套代码路径**；
这两处各自只是同一个东西的两种来源。

## 记录里没有 `enabled`

`ExtensionRecord` 说的是"这个包**注册**了什么"，所以它**不含开关**——开关在清单里
（包一行、每一条各自一行），那是"这台机器上要不要用它"，是另一个问题。
今天这两件事被塞进同一个字段，于是同一件事有两个地方在说，而它们会漂移。

## 四类，两个容器

`tools` / `executors` 住在**扩展包的清单**里；`schedules` / `providers` 各自
**一条一个文件**（`extensions/_schedules/` 和 `extensions/_providers/`）。

那两类凭什么叫独立：它们的干货是**数据**（什么时候跑 / 怎么连 + 一张模型目录），
装在包里要连带背一个用不上的包结构，而且**一个写错就毁掉整个包**。

## 包级 `defaults` 只服务 `executors`

它是"这个包里所有条目共享的底座"（`deepseek` 那一大坨 model / prompt / 旋钮默认值）。
**它到不了 `tools`**——包内实现住在一个单例里，读自己的 config；外部服务器的配置在
它自己那儿。清单说的是"它在哪、我们允不允许用"，服务器自己的配置说"它怎么干活"。

**合并是浅的：条目写了哪一栏，那一栏就整个是它的**（`model` 不是一层层拼起来的）。
深合并看着省事，代价是"这一格到底是谁写的"变成一道推理题——而清单是给人读的。
共用得多了，就写全；写全不会骗人。

← 来自 extensions/manifest.py（`SUPPORTED_TYPES` 已删）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

from .diagnostics import Diagnostic

#: 五类条目——包没有类型，`type` 说的是条目。
TYPE_KEYS = ("tools", "executors", "schedules", "providers", "channels")

REQUIRED: dict[str, tuple[str, ...]] = {
    "tools": ("name", "approval_required"),
    "executors": ("name",),
    "schedules": ("name", "cron"),
    "providers": ("name", "base_url", "api_key_env"),
    # 通道：**宿主的外围之手**（飞书那种），不是被审批的动作——它不走 `function/`。
    # 必填只有"它是谁"和"它在哪个文件里"，怎么送由它自己实现（`extensions/channels.py`）。
    "channels": ("name", "entrypoint"),
}

OPTIONAL: dict[str, tuple[str, ...]] = {
    "tools": ("url", "entrypoint", "idempotency"),
    "executors": ("worker", "executor", "needs_llm", "model", "prompt",
                  "parameters", "tools_from", "tighten"),
    "schedules": ("timezone", "executor_ref", "task_ref"),
    "providers": ("models",),
    "channels": (),
}

#: 每一条都有、而且含义不同的一栏——它答的是"要不要用它"，不是"它是什么"。
COMMON_OPTIONAL = ("enabled",)

#: 包层允许出现的键。
PACKAGE_KEYS = ("id", "name", "description", "version", "defaults") + COMMON_OPTIONAL + TYPE_KEYS

#: 「恰好一个」的两处。
EXACTLY_ONE = {"tools": ("url", "entrypoint"), "executors": ("worker", "executor")}

#: 布尔声明认的字符串写法（YAML 自己会把裸的 yes/no 解析成布尔，这里管的是带引号的）。
TRUE_WORDS = ("true", "yes", "on")
FALSE_WORDS = ("false", "no", "off")


# ── cron 与时区：**一句写坏的 cron 不是一份合法声明**

def timezone_of(name: str):
    """时区名 → tzinfo。**UTC 走标准库那条**——Windows 上不带 tz 数据库，
    写 UTC 的人不该被一个 ZoneInfoNotFoundError 拦住。

    它和 `cron_matches` 住同一处，理由也一样：`timezone` 是 `schedules` 的一栏，
    而"`Mars/Olympus` 不是一个时区"该在**写进去的时候**就知道——不然那条日程
    会安静地每次到点都记一条失败，用户看到的却是"它从来没跑过"。
    """
    key = str(name or "UTC").strip()
    if key.upper() in {"UTC", "ETC/UTC", "Z"}:
        return timezone.utc
    return ZoneInfo(key)


def cron_matches(expression: str, moment: Any) -> bool:
    """这段表达式在**这个墙上时间**成立吗。5 段：分 时 日 月 星期。

    它住在这里，因为"这句话是不是一句 cron"是**声明形状**的一部分——`cron` 是
    `schedules` 的必填栏，而"写了个错别字"该在写进去的时候就知道，不是等到某天早上
    它没跑、而用户以为它跑过了。派发那边（`tasks/scheduler.py`）import 它来对时间。
    """
    fields = str(expression or "").split()
    if len(fields) != 5:
        raise ValueError(f"cron 必须是 5 段表达式: {expression!r}")
    minute, hour, day, month, weekday = fields
    cron_weekday = (moment.weekday() + 1) % 7          # 星期天是 0
    day_match = _cron_field(moment.day, day, 1, 31)
    weekday_match = _cron_field(cron_weekday, weekday, 0, 7)
    # 老规矩：日和周**都**被限定时取"或"，否则取"与"。
    calendar = ((day_match or weekday_match) if day != "*" and weekday != "*"
                else day_match and weekday_match)
    return (_cron_field(moment.minute, minute, 0, 59)
            and _cron_field(moment.hour, hour, 0, 23)
            and _cron_field(moment.month, month, 1, 12)
            and calendar)


def _cron_field(value: int, expression: str, minimum: int, maximum: int) -> bool:
    for item in str(expression).split(","):
        item = item.strip()
        if not item:
            continue
        base, _, step_text = item.partition("/")
        step = int(step_text) if step_text else 1
        if step <= 0:
            raise ValueError("cron 步长必须为正数")
        if base == "*":
            start, end = minimum, maximum
        elif "-" in base:
            left, right = base.split("-", 1)
            start, end = int(left), int(right)
        else:
            start = end = int(base)
        if start < minimum or end > maximum or start > end:
            raise ValueError(f"cron 值超出范围: {item}")
        if start <= value <= end and (value - start) % step == 0:
            return True
    return False


@dataclass(frozen=True)
class Tool:
    name: str
    approval_required: bool
    url: str = ""
    entrypoint: str = ""
    idempotency: str = "safe-retry"
    enabled: bool = True

    @property
    def is_external(self) -> bool:
        """外面在跑的那台服务器——只连不碰。"""
        return bool(self.url)


@dataclass(frozen=True)
class Executor:
    name: str
    worker: dict[str, Any] | None = None
    executor: str = ""
    needs_llm: bool = False
    model: dict[str, Any] | None = None
    prompt: dict[str, Any] | None = None
    parameters: dict[str, Any] = field(default_factory=dict)
    tools_from: tuple[str, ...] = ()
    tighten: tuple[str, ...] = ()
    enabled: bool = True

    @property
    def is_configured(self) -> bool:
        """**基于另一个执行者的**——也就是"配置后的执行者"，人话叫智能体。"""
        return bool(self.executor)


@dataclass(frozen=True)
class Schedule:
    name: str
    cron: str
    #: 工作区里那份正文的引用。**可以没有**——缺了就是"这次运行没有正文"，
    #: 而不是一句写错的声明（`inputs.py::read` 第一行就是 `if not task_ref`）。
    task_ref: str = ""
    timezone: str = ""
    executor_ref: str = ""
    enabled: bool = True
    #: **这份声明在哪**。名字和文件名可以不同（`weather-daily.yaml` 里写着
    #: `name: weather.daily`），所以路径只能读出来，推不出来。
    path: str = ""


@dataclass(frozen=True)
class Channel:
    """一条**消息通道**：宿主往外送东西的那只手（飞书那种）。

    它和工具**不是一类**：工具是被审批的动作（走 `function/` 那条管线），通道是
    宿主自己的手——它只负责把一份已经决定要送出去的描述变成外面看得见的东西。
    """

    name: str
    entrypoint: str = ""
    enabled: bool = True
    #: 见 `Schedule.path`。
    path: str = ""


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    api_key_env: str
    models: tuple[dict[str, Any], ...] = ()
    enabled: bool = True
    #: 见 `Schedule.path`。
    path: str = ""


@dataclass(frozen=True)
class Package:
    """一个扩展包**声明**了什么。`enabled` 在包层也有一行——那是总闸。"""

    id: str
    enabled: bool = True
    name: str = ""
    description: str = ""
    version: str = ""
    defaults: dict[str, Any] = field(default_factory=dict)
    tools: tuple[Tool, ...] = ()
    executors: tuple[Executor, ...] = ()
    channels: tuple[Channel, ...] = ()
    path: str = ""

    @property
    def has_tools(self) -> bool:
        return bool(self.tools)

    @property
    def has_executors(self) -> bool:
        return bool(self.executors)


# ── 读

def manifest_path(package_dir: Path) -> Path:
    """包的清单在哪。**`.yml` 直接拒**——两处判断不一致过一次，现在只有一处。"""
    yml = package_dir / "manifest.yml"
    if yml.is_file():
        raise ValueError(f"清单只能用 manifest.yaml，不能用 .yml: {yml}")
    return package_dir / "manifest.yaml"


def read_manifest(package_dir: Path) -> Package:
    """读一个包的清单并校验它。**不 import 任何东西。**"""
    path = manifest_path(package_dir)
    if not path.is_file():
        raise ValueError(f"找不到清单: {path}")
    data = _load_yaml(path)
    return parse_package(data, fallback_id=package_dir.name, path=str(package_dir))


def read_schedule(path: Path) -> Schedule:
    entry = parse_entry(_load_yaml(path), "schedules", fallback_name=path.stem, where=str(path))
    return Schedule(**entry, path=str(path))


def read_provider(path: Path) -> Provider:
    entry = parse_entry(_load_yaml(path), "providers", fallback_name=path.stem, where=str(path))
    return Provider(**entry, path=str(path))


def _load_yaml(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"声明读不出来: {path}: {exc}") from exc
    return _parse_text(text, where=str(path))


def _parse_text(text: str, *, where: str = "声明") -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ValueError(f"{where} 读不出来（YAML 有问题）: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{where} 必须是一个对象")
    return data


# ── 写前校验：给 `extensions/writer.py` 用的那三个
#
# 校验的是**将要写出去的那段文本**，不是磁盘上的旧文本——所以写坏了的东西根本落不了盘，
# 而不是"下次重启才发现"。它们和读盘那三个走同一套 `parse_*`，**形状只有一份**。

def validate_package(text: str, name: str = "") -> None:
    parse_package(_parse_text(text, where=f"{name or '清单'}"), fallback_id=name)


def validate_schedule(text: str, name: str = "") -> None:
    parse_entry(_parse_text(text, where=f"{name or '日程'}"), "schedules", fallback_name=name)


def validate_provider(text: str, name: str = "") -> None:
    parse_entry(_parse_text(text, where=f"{name or '供应商'}"), "providers", fallback_name=name)


# ── 校验

def parse_package(data: dict[str, Any], *, fallback_id: str = "", path: str = "") -> Package:
    _reject_unknown(data, PACKAGE_KEYS, where=path or "清单")
    package_id = str(data.get("id") or fallback_id).strip()
    if not package_id:
        raise ValueError("包必须有 id")
    defaults = data.get("defaults") or {}
    if not isinstance(defaults, dict):
        raise ValueError("defaults 必须是一个对象")
    _reject_unknown(defaults, OPTIONAL["executors"] + COMMON_OPTIONAL,
                    where=f"{package_id} 的 defaults")

    return Package(
        id=package_id,
        enabled=_flag(data, "enabled", default=True),
        name=str(data.get("name") or ""),
        description=str(data.get("description") or ""),
        version=str(data.get("version") or ""),
        defaults=defaults,
        tools=tuple(Tool(**parse_entry(item, "tools", fallback_name="", where=package_id))
                    for item in _entries(data, "tools", package_id)),
        channels=tuple(Channel(**parse_entry(item, "channels", fallback_name="", where=package_id))
                       for item in _entries(data, "channels", package_id)),
        executors=tuple(Executor(**parse_entry(_under(item, defaults), "executors",
                                                fallback_name="", where=package_id))
                        for item in _entries(data, "executors", package_id)),
        path=path,
    )


def parse_entry(data: Any, type_key: str, *, fallback_name: str = "",
                where: str = "") -> dict[str, Any]:
    """校验**一条**条目，返回它的字段字典。四类走的是同一张表——不管它在哪个容器里。"""
    if type_key not in REQUIRED:
        raise ValueError(f"不认识这一类条目: {type_key}")
    if not isinstance(data, dict):
        raise ValueError(f"{where} 的 {type_key} 条目必须是一个对象")

    allowed = REQUIRED[type_key] + OPTIONAL[type_key] + COMMON_OPTIONAL
    _reject_unknown(data, allowed, where=f"{where} 的 {type_key} 条目")

    entry = dict(data)
    name = str(entry.get("name") or fallback_name).strip()
    if not name:
        raise ValueError(f"{where} 的 {type_key} 条目缺少 name")
    entry["name"] = name
    entry["enabled"] = _flag(entry, "enabled", default=True)

    for key in REQUIRED[type_key]:
        if key == "name":
            continue
        if entry.get(key) in (None, ""):
            raise ValueError(f"{name} 缺少必填栏: {key}")

    pair = EXACTLY_ONE.get(type_key)
    if pair:
        present = [key for key in pair if entry.get(key) not in (None, "", [], {})]
        if len(present) != 1:
            raise ValueError(
                f"{name} 必须**恰好**声明 {' 或 '.join(pair)} 之一，现在有 {len(present)} 个")

    if type_key in ("tools", "channels"):
        # 通道只有一种供给方式：包内入口（飞书那种"外面一个 API"是实现里的事，
        # 不是声明里的事）。工具两种（url / entrypoint），由 EXACTLY_ONE 管。
        if type_key == "channels" and not str(entry.get("entrypoint") or "").strip():
            raise ValueError(f"{name} 的通道必须写 entrypoint（形如 channel.py:Feishu）")
    if type_key == "tools":
        entry["approval_required"] = _flag(entry, "approval_required", default=False)
        entry["idempotency"] = str(entry.get("idempotency") or "safe-retry")
    if type_key == "executors":
        entry["needs_llm"] = _flag(entry, "needs_llm", default=False)
        for key in ("tools_from", "tighten"):
            value = entry.get(key) or ()
            if not isinstance(value, (list, tuple)):
                raise ValueError(f"{name} 的 {key} 必须是一个列表")
            entry[key] = tuple(str(item) for item in value)
        if entry.get("parameters") is None:
            entry["parameters"] = {}
        if not isinstance(entry["parameters"], dict):
            raise ValueError(f"{name} 的 parameters 必须是一个对象")
        if entry.get("worker") is not None and not isinstance(entry["worker"], dict):
            raise ValueError(f"{name} 的 worker 必须是一个对象")
    if type_key == "schedules":
        try:
            # **不匹配任何时刻**，只问它解不解得开——写坏的 cron 不该能登记进来。
            cron_matches(str(entry.get("cron") or "* * * * *"), _any_moment())
        except (ValueError, TypeError) as exc:
            raise ValueError(f"{name} 的 cron 写不出来: {entry.get('cron')!r}（{exc}）") from exc
        zone = str(entry.get("timezone") or "")
        if zone:
            try:
                # 时区同理：解不开的时区不是"跑不起来的配置"，是一句写错的声明。
                # （留空仍然可以——那是"用 UTC"，由 `timezone_of` 的默认值兜住。）
                timezone_of(zone)
            except Exception as exc:                  # noqa: BLE001 — 包的错，原样说
                raise ValueError(f"{name} 的时区读不出来: {zone!r}（{exc}）") from exc
    if type_key == "providers":
        models = entry.get("models") or []
        if not isinstance(models, list):
            raise ValueError(f"{name} 的 models 必须是一个列表")
        entry["models"] = tuple(
            {**item, "name": str(item.get("name") or "")} if isinstance(item, dict) else item
            for item in models)
    return entry


def _any_moment():
    """校验用的一个时刻。**内容不重要**——问的是"这句话解不解得开"。"""
    from datetime import datetime
    return datetime(2026, 1, 1)


def _under(item: Any, defaults: dict[str, Any]) -> Any:
    """把包级底座垫在条目下面：**条目写了的归条目**。"""
    return {**defaults, **item} if isinstance(item, dict) else item


def _entries(data: dict[str, Any], type_key: str, package_id: str) -> list[Any]:
    raw = data.get(type_key) or []
    if not isinstance(raw, list):
        raise ValueError(f"{package_id} 的 {type_key} 必须是一个列表")
    return raw


def _flag(data: dict[str, Any], key: str, *, default: bool) -> bool:
    """一栏布尔声明。**只认真布尔和明确的布尔写法。**

    不用 `bool(value)`：`"false"` 是个非空字符串，`bool("false")` 是**真**——那一格
    写错一个引号，开关就静默地反了。所以认不出的写法当场拒。
    """
    if key not in data or data[key] is None:
        return default
    value = data[key]
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in TRUE_WORDS + FALSE_WORDS:
        return value.strip().lower() in TRUE_WORDS
    raise ValueError(f"{key} 只能写 true / false，收到: {value!r}")


def _reject_unknown(data: dict[str, Any], allowed: tuple[str, ...], *, where: str) -> None:
    unknown = sorted(set(data) - set(allowed))
    if unknown:
        raise ValueError(f"{where} 不认识这些栏: {' · '.join(unknown)}")


# ── 撞名：三层，全在扫描期

def conflicting(packages: list[Package], schedules: list[Schedule],
                providers: list[Provider]) -> tuple[Diagnostic, ...]:
    """谁和谁撞了名字。

    **判据全在声明里**，所以这一步不需要任何代码跑起来——这正是"扫描 = 登记"完整的理由。
    顺序是**后到的失败**（按包的 id 排序，所以结论稳定，不看文件系统目录序）。
    """
    found: list[Diagnostic] = []
    seen_packages: dict[str, str] = {}
    seen_names: dict[tuple[str, str], str] = {}

    for package in packages:
        if package.id in seen_packages:
            found.append(Diagnostic(package.id, package.path, "scan",
                                    f"包名和 {seen_packages[package.id]} 撞了"))
            continue
        seen_packages[package.id] = package.path
        for type_key, entries in (("tools", package.tools), ("executors", package.executors)):
            for entry in entries:
                key = (type_key, entry.name)
                if key in seen_names:
                    found.append(Diagnostic(package.id, package.path, "scan",
                                            f"{type_key} 的名字 {entry.name} 和 {seen_names[key]} 撞了"))
                else:
                    seen_names[key] = package.path

    for kind, items in (("schedules", schedules), ("providers", providers)):
        for item in items:
            key = (kind, item.name)
            if key in seen_names:
                found.append(Diagnostic(item.name, "", "scan",
                                        f"{kind} 的名字和 {seen_names[key]} 撞了"))
            else:
                seen_names[key] = f"{kind}/{item.name}"

    return tuple(found)
