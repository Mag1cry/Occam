"""一个包交给系统的**是什么**。

两种供给，一个形状：

- **包里那种**：一个单例，它的公开函数就是工具。调用就是一次普通函数调用。
- **外面那种**：一条连接，工具清单是**问出来**的。

这里验的是**交给系统的那个形状**——工具叫什么、模型怎么知道参数、调用怎么走。
不验"谁是句柄"：那是 `gateway/function/` 的事（这一层交出去的是**实现**）。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.extensions.manifest import Tool as Declaration
from src.extensions.tools import load_supply, schema_from_signature
from tests.support.mcpserver import FakeMcpServer

PROVIDER = '''\
"""一个天气包。"""


class Weather:
    """一个城市一个城市地查。"""

    def __init__(self):
        self.calls = 0

    def current(self, city: str, units: str = "metric") -> dict:
        """Current conditions for a city."""
        self.calls += 1
        return {"city": city, "units": units, "calls": self.calls}

    def wind(self, city: str, at: float | None = None) -> dict:
        """Wind speed."""
        return {"city": city, "at": at}

    def _secret(self, token: str) -> str:
        """内部用的，不是工具。"""
        return token

    @property
    def label(self) -> str:
        """读它不算调用它。"""
        return "weather"

    def __eq__(self, other: object) -> bool:
        return False
'''


@pytest.fixture
def package(tmp_path: Path) -> Path:
    root = tmp_path / "weather"
    root.mkdir()
    (root / "provider.py").write_text(PROVIDER, encoding="utf-8")
    (root / "config.yaml").write_text("endpoint: https://example.invalid\n", encoding="utf-8")
    return root


@pytest.fixture
def weather(package: Path):
    supply = load_supply(package, Declaration(name="weather", approval_required=False,
                                              entrypoint="provider.py:Weather"))
    yield supply
    supply.close()


def _tool(supply, tool_id: str):
    return [t for t in supply.tools if t.tool_id == tool_id][0]


# ── 哪些函数算工具

def test_单例的公开函数就是工具(weather):
    assert [t.tool_id for t in weather.tools] == ["weather.current", "weather.wind"]


@pytest.mark.parametrize("not_a_tool, why", [
    ("weather._secret", "私有"),
    ("weather.label", "property：读它不是调它"),
])
def test_四类不算工具(weather, not_a_tool, why):
    assert not_a_tool not in [t.tool_id for t in weather.tools]


def test_dunder_不算工具(weather):
    assert not any(t.tool_id.endswith("__eq__") for t in weather.tools)


def test_全名是供给名加函数名(weather):
    """`weather.current` —— 供给名已唯一，一台供给里的函数名天生唯一，
    所以这个复合键也是唯一的（撞名检查因此不用管工具全名）。
    """
    assert all(t.tool_id.startswith("weather.") for t in weather.tools)


# ── schema 从签名读出来

def test_参数是从签名读的(weather):
    schema = _tool(weather, "weather.current").input_schema

    assert schema["type"] == "object"
    assert sorted(schema["properties"]) == ["city", "units"]
    assert schema["properties"]["city"]["type"] == "string"


def test_有默认值就不必填(weather):
    schema = _tool(weather, "weather.current").input_schema

    assert schema["required"] == ["city"]
    assert schema["properties"]["units"]["default"] == "metric"


def test_描述取_docstring_第一行(weather):
    assert _tool(weather, "weather.current").description == "Current conditions for a city."


def test_X_or_None_去掉_None_之后照常映射(weather):
    schema = _tool(weather, "weather.wind").input_schema

    assert schema["properties"]["at"]["type"] == "number"
    assert schema["required"] == ["city"]        # at 有默认值，所以不必填


def test_包里写了_future_annotations_也没关系(tmp_path: Path):
    """**这一条是真踩过的坑。**

    `from __future__ import annotations` 会让所有注解变成**字符串**（PEP 563），
    而那一行在包里很常见。不求值的话，`city: str` 读到的是字符串 `"str"`，
    认不出——于是**整个 schema 全是空的**，而模型只能拿到一堆没有类型的参数。
    """
    root = tmp_path / "future"
    root.mkdir()
    (root / "provider.py").write_text(
        'from __future__ import annotations\n'
        '\n'
        '\n'
        'class Tools:\n'
        '    def find(self, query: str, limit: int = 10) -> dict:\n'
        '        """找一个东西。"""\n'
        '        return {"query": query, "limit": limit}\n',
        encoding="utf-8")

    supply = load_supply(root, Declaration(name="t", approval_required=False,
                                           entrypoint="provider.py:Tools"))
    schema = supply.tools[0].input_schema

    assert schema["properties"]["query"]["type"] == "string", schema
    assert schema["properties"]["limit"]["type"] == "integer", schema
    assert schema["required"] == ["query"], schema
    supply.close()


def test_一个工具都没有的供给是错的(tmp_path: Path):
    """安静地供出零个工具，界面上只会显示"这个包什么都没有"——而原因就丢了。"""
    root = tmp_path / "empty"
    root.mkdir()
    (root / "provider.py").write_text(
        'class Nothing:\n'
        '    def _hidden(self, x):\n'
        '        return x\n',
        encoding="utf-8")

    with pytest.raises(ValueError):
        load_supply(root, Declaration(name="empty", approval_required=False,
                                      entrypoint="provider.py:Nothing"))


def test_认不出的类型留空_不猜():
    """这不叫"没写校验"，叫**如实说不知道**——比替包作者编一个 string 诚实。"""
    def f(a, b: "SomeClass", c: int = 1):  # noqa: F821
        pass

    schema = schema_from_signature(f)

    assert schema["properties"]["a"] == {}
    assert schema["properties"]["b"] == {}
    assert schema["properties"]["c"]["type"] == "integer"
    assert schema["required"] == ["a", "b"]


# ── 调用

def test_调用就是一次普通函数调用(weather):
    result = _tool(weather, "weather.current").invoke({"city": "上海"})

    assert result["city"] == "上海"
    assert result["units"] == "metric"           # Python 自己填的默认值


def test_注册时实例化一次之后是同一个(weather):
    """单例的意思是：它在 `__init__` 里读配置、建连接池——**只做一次**。"""
    first = _tool(weather, "weather.current").invoke({"city": "上海"})
    second = _tool(weather, "weather.current").invoke({"city": "北京"})

    assert first["calls"] == 1
    assert second["calls"] == 2


def test_关掉就是销毁实例(weather):
    """**禁用是可逆的**：收掉之后那个单例没人引用了，GC 就能收它。

    它可能在 `__del__` / 关闭钩子上有活要干，所以这里验的是"真的放掉了"，
    不是"标记了一下"。
    """
    import gc
    import weakref

    instance = weather.tools[0].invoke.__closure__[0].cell_contents.__self__
    reference = weakref.ref(instance)

    weather.close()
    del instance
    gc.collect()

    assert reference() is None, "单例还活着——它的连接和文件就还占着"
    assert weather.tools == ()


# ── 外面那种：问出来的

def test_外部供给的工具清单是问出来的():
    with FakeMcpServer() as server:
        supply = load_supply(Path("."), Declaration(name="remote", approval_required=True,
                                                    url=server.url))

        assert [t.tool_id for t in supply.tools] == ["remote.search"]
        assert supply.tools[0].input_schema["required"] == ["q"]
        supply.close()


def test_外部供给的调用走协议():
    with FakeMcpServer() as server:
        supply = load_supply(Path("."), Declaration(name="remote", approval_required=True,
                                                    url=server.url))

        answer = supply.tools[0].invoke({"q": "季度"})

        assert answer[0]["text"] == "search: 季度"
        assert "tools/call" in server.seen_methods
        supply.close()


def test_外面那台连不上_这一台失败不连累别的():
    """超时是**主路径**，不是防御性写法——"它没起"是常态。"""
    from src.extensions.mcp_client import McpError

    with pytest.raises(McpError):
        load_supply(Path("."), Declaration(name="remote", approval_required=True,
                                           url="http://127.0.0.1:1/mcp"))
