"""**边界不是靠纪律，是靠机器能看见的依赖方向。**

这一份测的是**结构**，不是行为：谁 import 谁、内核有多薄、库里有几张表。
它值一个文件，因为这类性质**没有任何一条行为测试测得到**——一个目录长出一句
`from ..tasks import ...`，所有功能测试照样全绿，而设计已经塌了一角。

（判据是设计文档里那些「不」字句，逐条搬进这里。改设计时要一起改它。）
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1] / "src"
AREAS = ("core", "storage", "extensions", "gateway", "tasks", "web", "app")


def _modules():
    for path in sorted(ROOT.rglob("*.py")):
        if "__pycache__" in str(path):
            continue
        parts = path.relative_to(ROOT).with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if parts:
            yield ".".join(parts), path


def _edges() -> set[tuple[str, str]]:
    """目录级 import 边（相对 import 按本文件的包回推）。"""
    found: set[tuple[str, str]] = set()
    for name, path in _modules():
        mine = name.split(".")[0]
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            targets: list[str] = []
            if isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    here = path.relative_to(ROOT).with_suffix("").parts
                    depth = node.level - (0 if here[-1] != "__init__" else 1)
                    base = ".".join(here[:len(here) - depth] + tuple(base.split(".") if base else []))
                targets = [base, *(f"{base}.{a.name}" if base else a.name for a in node.names)]
            elif isinstance(node, ast.Import):
                targets = [a.name for a in node.names]
            for target in targets:
                head = target.split(".")[0]
                if head in AREAS and head != mine:
                    found.add((mine, head))
    return found


EDGES = _edges()


@pytest.mark.parametrize("source, allowed", [
    ("core", set()),                                    # 内核不 import 任何别的目录
    ("storage", {"core"}),                              # 存储只服务内核
    ("extensions", set()),                              # 加载器不认网关（收一个写入面）
    ("gateway", {"core", "extensions"}),                # 不碰 tasks（只收 Protocol）
    ("tasks", {"core", "extensions", "gateway"}),       # 不碰 web
    # web 可以问 **extensions** 要一个执行者的结果：结果归执行者的包，而接入面是
    # 那个问题的读者（`web/README.md` 的边界里没有一条禁它）。它**不碰 tasks**——
    # 起进程、终止进程是那边的事。
    ("web", {"core", "gateway", "extensions"}),
])
def test_依赖方向(source: str, allowed: set[str]):
    actual = {dst for src, dst in EDGES if src == source}
    assert actual <= allowed, f"{source}/ 不该 import 这些：{sorted(actual - allowed)}"


def test_没有东西反向依赖装配():
    """装配 → 全部；全部 → **不**反向 import 装配。

    （`serve.py` 是入口，不属于任何一层——它 import 装配是它的本分。）
    """
    assert {src for src, dst in EDGES if dst == "app"} <= {"serve"}


def test_内核是个把手_不是个大脑():
    """`Kernel` **每个方法体只有一行**——多一行就说明逻辑长进绑定里了。"""
    tree = ast.parse((ROOT / "core" / "kernel.py").read_text(encoding="utf-8"))
    kernel = next(node for node in tree.body
                  if isinstance(node, ast.ClassDef) and node.name == "Kernel")
    bodies = {node.name: node.body for node in kernel.body if isinstance(node, ast.FunctionDef)}
    assert bodies, "Kernel 一个方法都没有？"
    for name, body in bodies.items():
        assert len(body) == 1, f"Kernel.{name} 不止一行——它开始做别的事了"


def test_内核只存两样东西():
    """库里只有两张控制事实的表：**Task 和事件**。

    `occ_metadata` 是第三张，但它记的是"schema 自己做过什么"，不是控制事实。
    """
    from src.storage.schema import SCHEMA

    tables = {line.split()[5] for line in SCHEMA.splitlines()
              if line.upper().startswith("CREATE TABLE")}
    assert tables == {"tasks", "control_events", "occ_metadata"}
