"""从磁盘上的声明到"系统里有什么"。

一条完整的路：**扫描**（读声明，一行代码不跑）→ **加载**（真的把代码取回来）→
**重新识别**（全量重来）。中间那几条边界是这里的重点：

- 扫描**不 import**：一个跑不起来的包，扫描期照样看得见
- 关着的包**也在结果里**，只是没有工具
- 一个包坏了**不连累别的**（这正是"一条一条放"的理由）
- 智能体 = **基于另一个执行者的配置**，它继承的是**代码**不是名字
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.extensions.hotload import HotLoader
from src.extensions.loader import ExtensionLoader, Loaded

WEATHER_PROVIDER = '''\
"""天气工具。"""


class Weather:
    def current(self, city: str) -> dict:
        """Current conditions."""
        return {"city": city, "from": "v1"}
'''

WEATHER_MANIFEST = """\
id: weather
name: 天气
tools:
  - name: weather
    approval_required: false
    entrypoint: provider.py:Weather
executors:
  - name: weather.collect
    worker: {entrypoint: "worker.py:collect"}
"""

WORKER = "def collect(*args, **kwargs):\n    return None\n"


class RecordingRegistrar:
    """一个只记账的写入面。**它证明 `extensions/` 不 import 网关**。"""

    def __init__(self) -> None:
        self.history: list[Loaded] = []

    def replace(self, loaded: Loaded) -> None:
        self.history.append(loaded)

    @property
    def current(self) -> Loaded:
        return self.history[-1]


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    root = tmp_path / "extensions"
    package = root / "weather"
    package.mkdir(parents=True)
    (package / "manifest.yaml").write_text(WEATHER_MANIFEST, encoding="utf-8")
    (package / "provider.py").write_text(WEATHER_PROVIDER, encoding="utf-8")
    (package / "worker.py").write_text(WORKER, encoding="utf-8")
    return root


def _write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# ── 扫描：读声明，不跑代码

def test_扫描读得动一个包(tree):
    scan = ExtensionLoader(tree).scan()

    assert scan.ids == ("weather",)
    assert scan.diagnostics == ()
    assert scan.packages[0].tools[0].name == "weather"


def test_扫描不_import_任何东西(tmp_path: Path):
    """**清单读得出来就行**，哪怕它的 `provider.py` 是坏的——
    扫描期根本不会去碰它。
    """
    root = tmp_path / "extensions"
    _write(root, "broken/manifest.yaml",
           "id: broken\ntools:\n  - name: b\n    approval_required: false\n"
           "    entrypoint: provider.py:Nothing\n")
    _write(root, "broken/provider.py", "this is not python at all !!!\n")

    scan = ExtensionLoader(root).scan()

    assert scan.ids == ("broken",)
    assert scan.diagnostics == ()


def test_清单写坏的那个包不进列表_别的照常(tmp_path: Path):
    root = tmp_path / "extensions"
    _write(root, "good/manifest.yaml", "id: good\n")
    _write(root, "bad/manifest.yaml", "id: bad\ntools: 这不是一个列表\n")

    scan = ExtensionLoader(root).scan()

    assert scan.ids == ("good",)
    assert [item.package for item in scan.diagnostics] == ["bad"]


def test_两条日程和一家供应商各一个文件(tmp_path: Path):
    root = tmp_path / "extensions"
    _write(root, "_schedules/weather-daily.yaml",
           "name: weather.daily\ncron: '0 8 * * *'\ntask_ref: inputs/x.md\n")
    _write(root, "_providers/deepseek.yaml",
           "name: deepseek\nbase_url: https://api.deepseek.com/v1\n"
           "api_key_env: DEEPSEEK_API_KEY\n")

    scan = ExtensionLoader(root).scan()

    assert [s.name for s in scan.schedules] == ["weather.daily"]
    assert [p.name for p in scan.providers] == ["deepseek"]


# ── 加载：把代码取回来

def test_加载把工具取回来(tree):
    loader = ExtensionLoader(tree)

    loaded = loader.load(loader.scan())

    assert [t.implementation.tool_id for t in loaded.tools] == ["weather.current"]
    assert loaded.tools[0].package == "weather"
    assert loaded.tools[0].declaration.approval_required is False
    loaded.close()


def test_关着的包还在列表里_但没有工具(tmp_path: Path):
    """**前后端用同一份事实。** 关着的包不进列表，前端就只能自己另编一套概念。"""
    root = tmp_path / "extensions"
    _write(root, "weather/manifest.yaml", WEATHER_MANIFEST.replace("id: weather", "id: weather\nenabled: false"))
    _write(root, "weather/provider.py", WEATHER_PROVIDER)
    _write(root, "weather/worker.py", WORKER)

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())

    assert loaded.package_ids == ("weather",)
    assert loaded.disabled_ids == ("weather",)
    assert loaded.tools == ()
    loaded.close()


def test_关着的包_它的通道也不建(tmp_path: Path):
    """**"我把它禁了"必须是字面意思。**

    工具那一趟早就查 `package.enabled`，通道那一趟漏过——而通道不是"一个被允许的
    动作"，它是**宿主自己的手**：一条长连接、一份凭据（`config/.env` 里的），而且
    它占的是**独占资源**（同一应用的多条连接互相吃事件）。禁用没生效 = 你以为断了
    它，它还在那儿接着、抢着别人的事件。

    这条是实测撞上的：`enabled: false` 之后 `loaded.channels` 里**还有它**，
    `enabled()` 还答 true——只差一次投递就会连上去。
    """
    channel = '''\
"""一条只会答"我配好了"的通道（这条用例不碰网络）。"""


class Fake:
    def enabled(self) -> bool:
        return True

    def send_text(self, text: str) -> dict:
        return {"ok": True}
'''
    root = tmp_path / "extensions"
    manifest = ("id: pigeon\n{flag}channels:\n  - name: pigeon\n"
                "    entrypoint: \"channel.py:Fake\"\n")
    _write(root, "pigeon/manifest.yaml", manifest.format(flag=""))
    _write(root, "pigeon/channel.py", channel)

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())
    assert [item.name for item in loaded.channels] == ["pigeon"]   # 开着：建
    loaded.close()

    _write(root, "pigeon/manifest.yaml", manifest.format(flag="enabled: false\n"))
    loaded = loader.load(loader.scan())
    assert loaded.disabled_ids == ("pigeon",)
    assert loaded.channels == ()                                   # 关着：连通道都不建
    loaded.close()


def test_一个包起不来_别的照常(tmp_path: Path):
    root = tmp_path / "extensions"
    _write(root, "good/manifest.yaml",
           "id: good\ntools:\n  - name: g\n    approval_required: false\n"
           "    entrypoint: provider.py:Good\n")
    _write(root, "good/provider.py", "class Good:\n    def go(self) -> str:\n        return 'ok'\n")
    _write(root, "bad/manifest.yaml",
           "id: bad\ntools:\n  - name: b\n    approval_required: false\n"
           "    entrypoint: provider.py:Missing\n")
    _write(root, "bad/provider.py", "class NothingHere:\n    pass\n")

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())

    # 工具全名是 **供给名.函数名**——供给名是**条目名**（`g`），不是包名。
    assert [t.implementation.tool_id for t in loaded.tools] == ["g.go"]
    assert [item.package for item in loaded.diagnostics] == ["bad"]
    loaded.close()


def test_连不上的服务器这一台失败_别的照常(tmp_path: Path):
    root = tmp_path / "extensions"
    _write(root, "remote/manifest.yaml",
           "id: remote\ntools:\n  - name: r\n    approval_required: true\n"
           "    url: http://127.0.0.1:1/mcp\n")
    _write(root, "local/manifest.yaml",
           "id: local\ntools:\n  - name: l\n    approval_required: false\n"
           "    entrypoint: provider.py:L\n")
    _write(root, "local/provider.py", "class L:\n    def go(self) -> str:\n        return 'ok'\n")

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())

    assert [t.implementation.tool_id for t in loaded.tools] == ["l.go"]
    assert [item.package for item in loaded.diagnostics] == ["remote"]
    loaded.close()


# ── 执行者：两种来源

def test_自己带代码的执行者(tree):
    loader = ExtensionLoader(tree)

    loaded = loader.load(loader.scan())

    definition = loaded.executors[0]
    assert definition.name == "weather.collect"
    assert definition.worker.function == "collect"
    assert definition.is_configured is False
    loaded.close()


def test_智能体继承的是代码(tmp_path: Path):
    http = (Path(__file__).parent / "support" / "mcpserver.py").exists()
    root = tmp_path / "extensions"
    _write(root, "_providers/deepseek.yaml",
           "name: deepseek\nbase_url: https://api.deepseek.com/v1\n"
           "api_key_env: DEEPSEEK_API_KEY\n")
    _write(root, "agent/manifest.yaml",
           "id: agent\n"
           "executors:\n"
           "  - name: llm-loop\n"
           "    needs_llm: true\n"
           "    worker: {entrypoint: 'worker.py:run'}\n"
           "  - name: ops-readonly\n"
           "    executor: llm-loop\n"
           "    model: {provider: deepseek, name: deepseek-v4-pro}\n"
           "    prompt: {system: '你是运维执行者'}\n"
           "    tools_from: [workspace]\n"
           "    tighten: [workspace.search_text]\n")
    _write(root, "agent/worker.py", "def run(*a, **k):\n    return None\n")

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())

    names = [item.name for item in loaded.executors]
    assert names == ["llm-loop", "ops-readonly"]
    agent = loaded.executors[1]
    assert agent.is_configured is True
    assert agent.based_on == "llm-loop"
    assert agent.worker.function == "run", "配置继承的是**代码**，不是名字"
    assert agent.model["name"] == "deepseek-v4-pro"
    assert agent.tools_from == ("workspace",)
    assert agent.tighten == ("workspace.search_text",)
    loaded.close()


def test_基座不存在_登记了但标了毛病(tmp_path: Path):
    """**声明里有它，所以它必须在列表里。** 丢掉等于让"用户写了、写错了"从界面上消失——
    而它跑不了的原因跟着定义走（`why_not`），用户看得到该去改哪儿。
    """
    root = tmp_path / "extensions"
    _write(root, "agent/manifest.yaml", "\n".join([
        "id: agent",
        "executors:",
        "  - name: ops",
        "    executor: 没有这个",
        "    model: {provider: deepseek, name: x}",
        "",
    ]))

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())

    assert [item.name for item in loaded.executors] == ["ops"]
    assert loaded.executors[0].runnable is False
    assert "没有这个" in loaded.executors[0].why_not
    assert len(loaded.diagnostics) == 1, "日志里也要说得清"
    loaded.close()


def test_基座可以不写模型_它就是留给配置的位置(tmp_path: Path):
    """`langchain-agent` 那个 LLM 循环**不知道用户要用哪家模型**——
    模型是配置告诉它的（"一段代码被多个配置用"）。所以基座不写 `model` 是常态。
    """
    root = tmp_path / "extensions"
    _write(root, "agent/manifest.yaml",
           "id: agent\n"
           "executors:\n"
           "  - name: llm-loop\n"
           "    needs_llm: true\n"
           "    worker: {entrypoint: 'worker.py:run'}\n")
    _write(root, "agent/worker.py", "def run(*a, **k):\n    return None\n")

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())

    assert [item.name for item in loaded.executors] == ["llm-loop"]
    assert loaded.executors[0].model is None
    assert loaded.diagnostics == ()
    loaded.close()


def test_配置没给模型_登记了但跑不了(tmp_path: Path):
    """**要拦的是这一条**：基座要用模型、自己又没有，而配置也没给——
    那才会跑到一半才发现没模型。拦住它的是"能不能跑"（`runnable`），不是"登不登记"。
    """
    root = tmp_path / "extensions"
    _write(root, "agent/manifest.yaml",
           "id: agent\n"
           "executors:\n"
           "  - name: llm-loop\n"
           "    needs_llm: true\n"
           "    worker: {entrypoint: 'worker.py:run'}\n"
           "  - name: bare\n"
           "    executor: llm-loop\n")
    _write(root, "agent/worker.py", "def run(*a, **k):\n    return None\n")

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())

    assert [item.name for item in loaded.executors] == ["llm-loop", "bare"]
    bare = [item for item in loaded.executors if item.name == "bare"][0]
    assert bare.runnable is False
    assert "模型" in bare.why_not
    assert "model" in loaded.diagnostics[0].message
    loaded.close()


def test_基座在后一个包里也认得出(tmp_path: Path):
    """**加载是全局两趟**，不是一个包一个包地分两趟。

    `aaa` 按名字排在 `bbb` 前头，而它的基座在 `bbb` 里——按包走的话，
    读到 `aaa` 时基座还没出现，于是跨包继承被读成"基座不存在"。
    """
    root = tmp_path / "extensions"
    worker = "def run(*a, **k):\n    return None\n"
    _write(root, "aaa/manifest.yaml", "\n".join([
        "id: aaa",
        "executors:",
        "  - name: aaa.agent",
        "    executor: bbb.base",
        "",
    ]))
    _write(root, "aaa/worker.py", worker)
    _write(root, "bbb/manifest.yaml", "\n".join([
        "id: bbb",
        "executors:",
        "  - name: bbb.base",
        '    worker: {entrypoint: "worker.py:run"}',
        "",
    ]))
    _write(root, "bbb/worker.py", worker)

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())

    agent = [item for item in loaded.executors if item.name == "aaa.agent"][0]
    assert agent.problem == "", f"基座被读成不存在了: {agent.problem}"
    assert agent.worker.function == "run", "配置继承的是**代码**"


def test_包级底座垫在条目下面(tmp_path: Path):
    root = tmp_path / "extensions"
    _write(root, "agent/manifest.yaml",
           "id: agent\n"
           "defaults:\n"
           "  prompt: {system: '共用的话术'}\n"
           "executors:\n"
           "  - name: a\n"
           "    needs_llm: true\n"
           "    model: {provider: p, name: m}\n"
           "    worker: {entrypoint: 'worker.py:run'}\n"
           "  - name: b\n"
           "    needs_llm: true\n"
           "    model: {provider: p, name: m}\n"
           "    worker: {entrypoint: 'worker.py:run'}\n"
           "    prompt: {system: '我自己那一份'}\n")
    _write(root, "agent/worker.py", "def run(*a, **k):\n    return None\n")

    loader = ExtensionLoader(root)
    loaded = loader.load(loader.scan())
    by_name = {item.name: item for item in loaded.executors}

    assert by_name["a"].prompt["system"] == "共用的话术"
    assert by_name["b"].prompt["system"] == "我自己那一份", "条目写了的归条目"
    loaded.close()


# ── 撞名在 import 之前

def test_两个包撞名_第二个整包被拒(tmp_path: Path):
    """**撞名必须挡在 import 之前**：先 import 再发现撞名的话，
    那个包的代码已经进了宿主进程，"禁用"就无从谈起。
    """
    root = tmp_path / "extensions"
    for directory in ("a", "b"):
        _write(root, f"{directory}/manifest.yaml",
               f"id: same\nname: {directory}\n"
               f"tools:\n  - name: t\n    approval_required: false\n"
               f"    entrypoint: provider.py:T\n")
        _write(root, f"{directory}/provider.py", "class T:\n    def go(self) -> str:\n        return 'x'\n")

    scan = ExtensionLoader(root).scan()

    assert len(scan.packages) == 1
    assert len(scan.diagnostics) == 1


# ── 刷新与回滚

def test_刷新按磁盘上现在的声明重算(tmp_path: Path):
    """**改开关是一条真的路径**，不是标记一下：重读声明、重建供给、一次交给目录。"""
    root = tmp_path / "extensions"
    _write(root, "weather/manifest.yaml", WEATHER_MANIFEST)
    _write(root, "weather/provider.py", WEATHER_PROVIDER)
    _write(root, "weather/worker.py", WORKER)

    registrar = RecordingRegistrar()
    hot = HotLoader(root, registrar)
    first = hot.refresh()
    assert [t.implementation.tool_id for t in first.tools] == ["weather.current"]

    _write(root, "novel/manifest.yaml", "\n".join([
        "id: novel",
        "tools:",
        "  - name: n",
        "    approval_required: false",
        "    entrypoint: provider.py:N",
        "",
    ]))
    _write(root, "novel/provider.py", "\n".join([
        "class N:",
        "    def go(self) -> str:",
        "        return 'x'",
        "",
    ]))

    second = hot.refresh()

    assert sorted(t.implementation.tool_id for t in second.tools) == ["n.go", "weather.current"]
    assert len(registrar.history) == 2
    assert hot.current is second


def test_刷新会收掉上一批(tmp_path: Path):
    """**禁用 = 销毁实例**：交出去新那一份之后，上一份的供给要收掉——
    不收，旧单例还活着，占着它开的连接和文件。
    """
    root = tmp_path / "extensions"
    _write(root, "weather/manifest.yaml", WEATHER_MANIFEST)
    _write(root, "weather/provider.py", WEATHER_PROVIDER)
    _write(root, "weather/worker.py", WORKER)

    hot = HotLoader(root, RecordingRegistrar())
    first = hot.refresh()

    hot.refresh()

    assert all(supply.tools == () for supply in first.supplies), "上一批没收干净"


def test_改开关当场生效(tmp_path: Path):
    root = tmp_path / "extensions"
    _write(root, "weather/manifest.yaml", WEATHER_MANIFEST)
    _write(root, "weather/provider.py", WEATHER_PROVIDER)
    _write(root, "weather/worker.py", WORKER)
    hot = HotLoader(root, RecordingRegistrar())
    hot.refresh()

    _write(root, "weather/manifest.yaml",
           WEATHER_MANIFEST.replace("id: weather", "id: weather\nenabled: false"))
    loaded = hot.refresh()

    assert loaded.disabled_ids == ("weather",)
    assert loaded.tools == ()


def test_改了_py_源码要重启_刷新不会假装它生效(tmp_path: Path):
    """**这是取舍，不是缺陷。** 不再为了"改代码即时生效"维护一套全目录卸载——
    同一个目录第二次加载复用 `sys.modules` 里那份，所以刷新拿到的是**原来那个类**。
    """
    root = tmp_path / "extensions"
    _write(root, "weather/manifest.yaml", WEATHER_MANIFEST)
    _write(root, "weather/provider.py", WEATHER_PROVIDER)
    _write(root, "weather/worker.py", WORKER)
    hot = HotLoader(root, RecordingRegistrar())
    assert hot.refresh().tools[0].implementation.invoke({"city": "上海"})["from"] == "v1"

    _write(root, "weather/provider.py", WEATHER_PROVIDER.replace('"v1"', '"v2"'))

    assert hot.refresh().tools[0].implementation.invoke({"city": "上海"})["from"] == "v1"


def test_注册失败要把上一次那份原样交回去(tmp_path: Path):
    """**它是唯一会"倒带"的地方。** 不倒带就会留下一个"半个包"：
    名字占着、列表里有、但点下去调不通。
    """
    root = tmp_path / "extensions"
    _write(root, "weather/manifest.yaml", WEATHER_MANIFEST)
    _write(root, "weather/provider.py", WEATHER_PROVIDER)
    _write(root, "weather/worker.py", WORKER)

    class FlakyRegistrar(RecordingRegistrar):
        def __init__(self) -> None:
            super().__init__()
            self.fail_next = False

        def replace(self, loaded: Loaded) -> None:
            if self.fail_next:
                self.fail_next = False
                raise RuntimeError("网关注册到一半炸了")
            super().replace(loaded)

    registrar = FlakyRegistrar()
    hot = HotLoader(root, registrar)
    good = hot.refresh()

    _write(root, "second/manifest.yaml", "\n".join([
        "id: second",
        "tools:",
        "  - name: s",
        "    approval_required: false",
        "    entrypoint: provider.py:S",
        "",
    ]))
    _write(root, "second/provider.py", "\n".join([
        "class S:",
        "    def go(self) -> str:",
        "        return 'x'",
        "",
    ]))
    registrar.fail_next = True

    with pytest.raises(RuntimeError):
        hot.refresh()

    assert registrar.current is good, "倒带要把**上一次那份**原样交回去"
    assert hot.current is good
