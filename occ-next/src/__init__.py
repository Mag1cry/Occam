"""OCC Next：单用户、本地优先的控制面。

`src` 是**包名**，不是"源码目录"：`python -m src.serve` 起服务，扩展包里的 worker
也按这个名字 import（`from src.tasks.channel import WorkerChannel`）。所以这一层
必须是一个真的包——`pyproject.toml` 的 `module-name = "src"` 认的就是它，
少了这个文件 `uv build` 会说 `Expected a Python module at: src\\__init__.py`。

（子包各有各的 `README.md` 说明那一层的职责，从这里往下看。）
"""

__version__ = "0.1.0"
