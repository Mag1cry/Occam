"""写声明：**唯一能写它的地方**。

声明是唯一事实，所以写它这件事只有两条硬规矩：**别把文件写坏**（原子替换）、
**别把人的东西抹掉**（往返模式保住注释和缩进）。另外还有一条产品上的：
**开关按钮不能是死的**。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from src.extensions.writer import create_document, read_document, set_field

HAND_WRITTEN = """\
# 天气包：给运维看的
id: weather
enabled: true

tools:
  - name: weather            # 供给名
    approval_required: false
    entrypoint: provider.py:Weather

# 下面这块是底座，改之前先看 README
defaults:
  parameters:
    timeout: {type: integer, default: 30}
"""


@pytest.fixture
def declaration(tmp_path: Path) -> Path:
    path = tmp_path / "extensions" / "weather" / "manifest.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(HAND_WRITTEN, encoding="utf-8")
    return path


def test_改一个字段不会动别的东西(declaration):
    set_field(declaration, "enabled", False)

    text = declaration.read_text(encoding="utf-8")
    assert "# 天气包：给运维看的" in text          # 注释还在
    assert "# 下面这块是底座，改之前先看 README" in text
    assert "enabled: false" in text
    assert "  - name: weather            # 供给名" in text   # 行内注释和排布也在


def test_写出去的是_LF(declaration, tmp_path):
    set_field(declaration, "enabled", False)

    raw = declaration.read_bytes()
    assert b"\r\n" not in raw


def test_干净的清单照样关得掉(tmp_path):
    """`enabled` 是**允许凭空写进去的唯一一栏**。

    一份干净的清单里本来就没有它——而"关掉一个东西"恰恰就是写这一行。
    没有这个例外，配置舱那个开关按钮会被规则自己拒掉。
    """
    path = tmp_path / "extensions" / "clean" / "manifest.yaml"
    path.parent.mkdir(parents=True)
    path.write_text("id: clean\ntools:\n  - name: t\n    approval_required: false\n"
                    "    url: http://127.0.0.1:1/mcp\n", encoding="utf-8")
    assert "enabled" not in read_document(path)

    set_field(path, "enabled", False)

    assert read_document(path)["enabled"] is False


def test_别的字段不许凭空加(declaration):
    with pytest.raises(ValueError):
        set_field(declaration, "description", "新加的")

    assert "description" not in declaration.read_text(encoding="utf-8")


def test_校验不通过就不落盘(declaration):
    before = declaration.read_text(encoding="utf-8")

    def refuse(text: str) -> None:
        raise ValueError("这段声明不合法")

    with pytest.raises(ValueError):
        set_field(declaration, "enabled", False, validate=refuse)

    assert declaration.read_text(encoding="utf-8") == before
    assert not (declaration.with_name(declaration.name + ".tmp")).exists()


def test_按声明里的名字找得到那份声明(tmp_path: Path):
    """**文件名和声明里的名字可以不同。**

    `extensions/README.md` 的示例就是 `_schedules/weather-daily.yaml` 里写着
    `name: weather.daily`——用户嘴里的"那条日程"是它的**名字**，不是文件叫什么。
    只按文件名找的话，"停用一条日程"会答"找不到这份声明"。
    """
    from src.extensions.writer import Declarations

    root = tmp_path / "extensions"
    (root / "_schedules").mkdir(parents=True)
    (root / "_schedules" / "weather-daily.yaml").write_text(
        "\n".join(["name: weather.daily", "cron: '0 8 * * *'", "task_ref: inputs/x.md", ""]),
        encoding="utf-8")
    declarations = Declarations(root)

    assert declarations.path_of("schedule", "weather.daily").name == "weather-daily.yaml"
    # 文件名照旧找得到
    assert declarations.path_of("schedule", "weather-daily").name == "weather-daily.yaml"


def test_校验看见的是将要写出去的那段文本(declaration):
    seen: list[str] = []

    set_field(declaration, "enabled", False, validate=seen.append)

    assert seen and "enabled: false" in seen[0]


def test_新建一份声明(tmp_path):
    path = tmp_path / "extensions" / "_schedules" / "weather-daily.yaml"

    create_document(path, {"name": "weather.daily", "cron": "0 8 * * *",
                           "task_ref": "inputs/weather-daily.md", "enabled": True})

    document = read_document(path)
    assert document["name"] == "weather.daily"
    assert document["cron"] == "0 8 * * *"


def test_新建不会盖掉已有的(declaration):
    before = declaration.read_text(encoding="utf-8")

    with pytest.raises(ValueError):
        create_document(declaration, {"id": "别的"})

    assert declaration.read_text(encoding="utf-8") == before
