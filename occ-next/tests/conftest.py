"""测试夹具。

**目录名已经落定了**：源码包就叫 `src`（`python -m src.serve`），所以这里的 import
是 `from src.…`——那次"把 `src.` 前缀改回去"的最后一步已经做完了，别再留着改回去的
念头：`pyproject.toml` 的 `module-name = "src"` 只认这一个名字。
"""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "hello.txt").write_text("hello OCC", encoding="utf-8")
    return root


@pytest.fixture
def control_database(tmp_path: Path) -> Path:
    return tmp_path / "control.sqlite"


@pytest.fixture
def store(control_database: Path):
    from src.storage.control import SqliteCoreStore

    return SqliteCoreStore(control_database)


@pytest.fixture
def kernel(store):
    from src.core.kernel import Kernel

    return Kernel(store)
