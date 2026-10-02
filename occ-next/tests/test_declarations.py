"""一份声明合法不合法。

**全部在扫描期判完**——不用跑任何代码。这就是"扫描 = 登记"能完整的理由：
能被登记的，就一定被校验过。

这张表就是分散在旧代码三个加载器里的那些 `if`。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.extensions.manifest import (
    Package, conflicting, manifest_path, parse_entry, parse_package, read_provider,
    read_schedule,
)


def _package(package_id: str, **extra):
    return parse_package({"id": package_id, **extra}, fallback_id=package_id,
                         path=f"extensions/{package_id}")


# ── 一个包说自己有什么

def test_一个正常的包():
    package = _package("weather",
                       name="天气",
                       tools=[{"name": "weather", "approval_required": False,
                               "entrypoint": "provider.py:Weather"}],
                       executors=[{"name": "weather.collect",
                                   "worker": {"entrypoint": "provider.py:collect"}}])

    assert package.id == "weather"
    assert package.name == "天气"
    assert package.tools[0].entrypoint == "provider.py:Weather"
    assert package.tools[0].is_external is False
    assert package.executors[0].name == "weather.collect"


def test_智能体就是一个配置后的执行者():
    entry = parse_entry({"name": "ops-readonly", "executor": "langchain-agent",
                         "model": {"provider": "deepseek", "name": "deepseek-v4-pro"},
                         "prompt": {"system": "你是运维执行者"},
                         "tools_from": ["workspace"],
                         "tighten": ["workspace.search_text"]},
                        "executors", where="ops-readonly")

    assert entry["executor"] == "langchain-agent"
    assert entry["tools_from"] == ("workspace",)
    assert entry["tighten"] == ("workspace.search_text",)


def test_一个包可以有几条执行者():
    package = _package("weather", executors=[
        {"name": "weather.collect", "worker": {"entrypoint": "w.py:collect"}},
        {"name": "weather.alert", "worker": {"entrypoint": "w.py:alert"}},
    ])

    assert [e.name for e in package.executors] == ["weather.collect", "weather.alert"]


# ── 契约表真的会咬人

@pytest.mark.parametrize("entry, type_key, why", [
    ({"name": "x", "approval_required": False, "url": "u", "risk_level": "low"},
     "tools", "不认识的键"),
    ({"name": "x", "url": "u"}, "tools", "缺必填项"),
    ({"name": "x", "approval_required": False, "url": "u", "entrypoint": "a.py:B"},
     "tools", "两种供给都写了"),
    ({"name": "x", "approval_required": False}, "tools", "两种供给都没写"),
    ({"name": "x", "worker": {"entrypoint": "w.py:e"}, "executor": "y"},
     "executors", "两个来源都写了"),
    ({"name": "x"}, "executors", "两个来源都没写"),
    ({"name": "s", "cron": "每天九点", "task_ref": "i.md"}, "schedules",
     "cron 不是 5 段——写坏了不该能登记进来"),
    ({"name": "s", "cron": "0 8 * * *", "task_ref": "i.md", "timezone": "Mars/Olympus"},
     "schedules", "时区解不开——同样是一句写错的声明"),
    ({"name": "p", "base_url": "u"}, "providers", "缺 api_key_env"),
])
def test_不合法的条目会被拒(entry, type_key, why):
    with pytest.raises(ValueError):
        parse_entry(entry, type_key, where="某个包")


@pytest.mark.parametrize("data, why", [
    ({"id": "x", "type": "ability"}, "包不该有类型"),
    ({"id": "x", "display": {"name": "X"}}, "旧写法：display 块"),
    ({"id": "x", "provider": "deepseek"}, "旧写法：包级供应商"),
    ({"id": "x", "implementation": {"executor_type": "x"}}, "旧写法：implementation"),
])
def test_不合法的包会被拒(data, why):
    with pytest.raises(ValueError):
        parse_package(data, fallback_id="x")


def test_那五个零消费者的字段现在是未知键():
    """`target_type` / `risk_level` / `cancellable` / `function_name` / `idempotency` 里
    前四个被删了，所以它们现在**根本写不进去**——不是"写了没人读"，是"写了就被拒"。
    """
    with pytest.raises(ValueError):
        parse_entry({"name": "x", "approval_required": False, "url": "u",
                     "target_type": "workspace", "cancellable": False},
                    "tools", where="p")


# ── 开关

def test_每一条都有开关而且默认是开的():
    assert parse_entry({"name": "x", "approval_required": False, "url": "u"},
                       "tools")["enabled"] is True
    assert parse_entry({"name": "s", "cron": "0 8 * * *", "task_ref": "i.md"},
                       "schedules")["enabled"] is True
    assert _package("x").enabled is True


def test_可以关掉():
    assert parse_entry({"name": "s", "cron": "0 8 * * *", "task_ref": "i.md",
                        "enabled": False}, "schedules")["enabled"] is False
    assert _package("x", enabled=False).enabled is False


# ── 单文件的那两个容器

def test_日程一条一个文件(tmp_path: Path):
    path = tmp_path / "weather-daily.yaml"
    path.write_text("name: weather.daily\ncron: '0 8 * * *'\ntimezone: Asia/Shanghai\n"
                    "task_ref: inputs/weather-daily.md\nexecutor_ref: weather.collect\n",
                    encoding="utf-8")

    schedule = read_schedule(path)

    assert schedule.name == "weather.daily"
    assert schedule.timezone == "Asia/Shanghai"
    assert schedule.enabled is True


def test_日程可以不写输入引用():
    """**没有正文也是一条合法的日程**（`inputs.py::read` 第一行就是 `if not task_ref`）。

    和 `cron` 不同：`cron` 缺了猜不出来，而"这次运行没有正文"是一个安全的默认值——
    固定代码的执行者本来就不看它。把它列进必填会逼人编一个文件名，而那个文件一旦
    不存在，**每一次派发都会被它拦下**。
    """
    entry = parse_entry({"name": "s", "cron": "0 8 * * *"}, "schedules", where="t")

    assert entry["name"] == "s"
    assert not entry.get("task_ref")


def test_不写时区就是用_UTC():
    """留空不是"写坏了的时区"——`timezone_of` 的默认值就是 UTC，所以这条照收。

    这一格与 `cron` / `task_ref` 不同：它**可选**，缺了能填一个安全的默认值
    （`manifest.py` 顶上那张表里，判据就是这个）。
    """
    assert parse_entry({"name": "s", "cron": "0 8 * * *", "task_ref": "i.md"},
                       "schedules").get("timezone") in (None, "")


def test_供应商一家一个文件(tmp_path: Path):
    path = tmp_path / "deepseek.yaml"
    path.write_text("name: deepseek\nbase_url: https://api.deepseek.com/v1\n"
                    "api_key_env: DEEPSEEK_API_KEY\nmodels:\n"
                    "  - name: deepseek-flash\n  - name: deepseek-v4-pro\n",
                    encoding="utf-8")

    provider = read_provider(path)

    assert provider.name == "deepseek"
    assert [m["name"] for m in provider.models] == ["deepseek-flash", "deepseek-v4-pro"]


def test_清单只能用_manifest_yaml(tmp_path: Path):
    (tmp_path / "manifest.yml").write_text("id: x\n", encoding="utf-8")

    with pytest.raises(ValueError):
        manifest_path(tmp_path)


# ── 撞名：三层，全在扫描期

def test_两个包不能同名():
    first = _package("weather")
    second = _package("weather")

    found = conflicting([first, second], [], [])

    assert len(found) == 1
    assert found[0].stage == "scan"


def test_撞了名字的包整包被拒_它的条目不再被扫():
    first = parse_package({"id": "weather", "tools": [
        {"name": "weather.current", "approval_required": False, "url": "u"}]},
        fallback_id="weather")
    second = parse_package({"id": "weather", "tools": [
        {"name": "别的工具", "approval_required": False, "url": "u"}]},
        fallback_id="weather")

    found = conflicting([first, second], [], [])

    assert len(found) == 1, "整包被拒之后，它里面那条不该再报一次"


def test_两类条目各管各的命名空间():
    """一个叫 `weather` 的工具和一个叫 `weather` 的执行者**不是撞名**——
    名字的含义由它的词条决定。
    """
    package = _package("w", tools=[{"name": "weather", "approval_required": False, "url": "u"}],
                       executors=[{"name": "weather", "worker": {"entrypoint": "w.py:e"}}])

    assert conflicting([package], [], []) == ()


def test_工具全名和执行者全名对上是故意的():
    """一个函数两个身份——**缝起来的是名字**。它不是撞名，是缝合，
    所以撞名检查不该把它拦下来。
    """
    package = _package("weather",
                       tools=[{"name": "weather", "approval_required": False,
                               "entrypoint": "provider.py:Weather"}],
                       executors=[{"name": "weather.collect",
                                   "worker": {"entrypoint": "provider.py:collect"}}])

    assert conflicting([package], [], []) == ()


def test_日程和供应商也在各自的命名空间里():
    schedule = read_schedule_from({"name": "weather.daily", "cron": "0 8 * * *",
                                   "task_ref": "i.md"})
    provider = read_provider_from({"name": "deepseek", "base_url": "u", "api_key_env": "K"})

    assert conflicting([_package("w")], [schedule], [provider]) == ()


# ── 小工具：直接造对象，不碰盘

def read_schedule_from(data: dict):
    from src.extensions.manifest import Schedule
    return Schedule(**parse_entry(data, "schedules", where="t"))


def read_provider_from(data: dict):
    from src.extensions.manifest import Provider
    return Provider(**parse_entry(data, "providers", where="t"))
