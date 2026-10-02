"""加载包目录里的 Python（合成包，支持相对 import）。

**它服务两处**，都是"包内的 Python"：

| 谁 | 什么时候 |
| --- | --- |
| **工具的单例** | 注册时 import 那个 `entrypoint`，实例化一次 |
| **执行者的 worker / adapter** | 起 worker 时（子进程里）、读结果时（宿主里） |

外部供给（MCP 服务器）不经过它——那是另一个进程，我们只连。

合成包是为了让包内的相对 import 能用：扩展目录不在 `sys.path` 上，直接 `import` 会
找不到同目录的兄弟文件。

## 改源码要重启，这里不管卸载

已经 import 过的模块改不了。所以**改扩展的 `.py` 源码之后重启宿主**——这不是遗憾，
是取舍：为了"改代码即时生效"要维护一套全目录卸载（清 `sys.modules`、认领合成包、
处理命名空间包的惰性 `__path__`），而启用/停用、改声明本来就会重读声明、重建供给。
**唯一换不到的是源码那一格，而那一格用重启解决。**

所以这一层只有**一个**对外函数：`load_entrypoint`。它自己那次调用失败时会撤掉本次
新冒出来的模块（见下），那是**为了不留半初始化状态**，不是为了热替换。

**有一格不归这一层管**：改完的文件若与上一版**落在同一秒里、大小又没变**，CPython
的 `.pyc` 会把旧字节码判成没过期——读到的是 `.pyc`，不是源码。那是字节码缓存的事，
`sys.modules` 这一层看不见它，也不该去动它。（重启之后自然就好了。）

## 对外只有一个函数

```python
Weather = load_entrypoint(pkg_dir, "provider.py:Weather")        # → 那个类本身
worker_entry = load_entrypoint(pkg_dir, "worker.py:worker_entry")  # → 那个函数本身
```

**加载不实例化、不调用。** 属性是什么由调用方决定：工具那条路拿到一个类，注册时自己
实例化一次（成单例）；worker 那条路拿到一个函数，子进程里自己调。这一层要是替谁实例化了，
"实例化"就变成加载的副作用——而它其实是"这个东西在系统里存在"的那一步。

**同一个目录第二次加载直接复用 `sys.modules` 里那份。** 重跑一遍文件会造出第二个类
对象，`isinstance` 当场失效：包作者写的类型判断会莫名其妙地不成立。

## 合成包名是算出来的，不是目录名

目录名不能用：它会撞（两个根下都可能有 `weather`），也可能撞上真的模块（`json`）。
所以包名 = 前缀 + **目录绝对路径**的 sha256 前 16 位。路径先进 `resolve()`，于是
"同一个目录"永远等于"同一个名字"。

## 入口必须落在包目录里

`entrypoint` 里的文件路径先 `resolve()`、再 `relative_to()` 卡一次，越界就拒。
**这不是防攻击，是防手滑**：清单里写错一格，加载到的就是另一份谁也不认识的文件，
而它会以完全正常的样子跑起来。

## 失败回滚认路径，不认哈希

遍历 `sys.modules`，凡是从这个目录加载出来的（`__file__` 或 `__path__` 落在目录下）
一律撤掉；合成包**本身**再按名字认领一次——没有 `__init__.py` 时那个空包没有
`__file__`，只靠路径认不出它。

**不按包名里的哈希反推目录。** 名字是算出来的，公式一改（前缀、算法、截断长度），
按名字认领的那份清理就会**静默失效**：它删不掉，也不报错，下一次加载于是命中上一个
版本的残骸——"改完源码再试一次"试的还是旧那份。路径不随公式变，所以不会。

## 失败不留渣

装载途中出错时，这次调用**新冒出来的**那些模块会撤掉，再抛 `RuntimeError`。留一份
半初始化的模块在 `sys.modules` 里，下一次加载会直接命中它——而"执行到一半"的模块和
"执行完"的模块从外面看不出区别（它甚至可能只是少了一个属性）。

判据是**调用前后各拍一次 `sys.modules` 的名字**，不是"我登记了哪几个"：入口用
相对 import 拉进来的兄弟模块（`from .graph import ...`）不经过这里登记，只认名字
根本记不全——漏掉它们，下次加载会得到"入口重读了、兄弟还是旧的"这种拼盘。

只撤新冒出来的那批：同一个目录里上一个入口加载成功留下的模块是别人的成果，动它会
造出两份类对象（上面那条 `isinstance` 的毛病）。

← 来自 extensions/runtime.py
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.machinery
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

# 合成包名的前缀。它只在这里出现一次，`forget` 认路径，不靠它认领。
_SYNTHETIC_PREFIX = "occ_extension_"

# 属性缺失的哨兵：`None` 也是合法的属性值，不能拿它当"没有"。
_MISSING = object()


def load_entrypoint(package_dir: Path, entrypoint: str) -> Any:
    """按 `entrypoint`（形如 `"provider.py:Weather"`）取回那个属性本身。

    不实例化、不调用——属性交给调用方处置。同一个文件第二次调用直接复用已在
    `sys.modules` 里的那份模块，不重跑文件。
    """
    root = Path(package_dir).resolve()
    if not root.is_dir():
        raise RuntimeError(f"包目录不存在: {root}")
    relative, attribute = _split_entrypoint(entrypoint)
    source = (root / relative).resolve()
    try:
        source.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"扩展入口必须落在包目录内: {source} 不在 {root} 之下") from exc
    if not source.is_file():
        raise RuntimeError(f"扩展入口文件不存在: {source}")

    # 这次调用开始**之前**就在 `sys.modules` 里的名字。失败时靠它分清"这次新冒出来的"
    # 和"上一次加载留下的"——后者不能动（见模块说明：动它会造出两份类对象）。
    before = frozenset(sys.modules)
    try:
        package_name = _package_name(root)
        _ensure_package(package_name, root)
        module_name = _submodule_name(package_name, source.relative_to(root))
        _ensure_parents(module_name)
        module = _load_file_module(module_name, source)
    except Exception as exc:
        _drop_from_dir(root, before)
        # 我们自己抛的那几条已经说清是哪个文件、哪一步了，原样往上走；
        # 包里代码抛的（import 失败、`__init__.py` 报错）在这里补上落点。
        if isinstance(exc, RuntimeError):
            raise
        raise RuntimeError(f"加载扩展入口失败: {source}") from exc

    value = getattr(module, attribute, _MISSING)
    if value is _MISSING:
        # 属性不在，多半是清单里写错了名字。这份模块本身是好的，但这次调用没有成功，
        # 所以一起撤掉——下一次会重读文件，改完代码就能生效，不用等全量重来。
        _drop_from_dir(root, before)
        raise RuntimeError(f"扩展入口里没有这个属性: {source}:{attribute}")
    return value


def _split_entrypoint(entrypoint: str) -> tuple[Path, str]:
    """把 `"provider.py:Weather"` 拆成（相对文件、属性名），顺手判掉形状。

    从**右边**切第一刀（`rpartition`）：文件名里不许有冒号，而 Windows 的盘符有——
    从左边切会把 `C:` 当成分隔符。
    """
    filename, separator, attribute = entrypoint.rpartition(":")
    if not separator or not filename.strip() or not attribute.strip():
        raise RuntimeError(f"扩展入口要写成 file.py:属性，收到: {entrypoint!r}")
    if not attribute.isidentifier():
        raise RuntimeError(f"扩展入口的属性名不是合法标识符: {entrypoint!r}")
    relative = Path(filename.strip())
    if relative.suffix != ".py":
        raise RuntimeError(f"扩展入口要指向 .py 文件: {entrypoint!r}")
    return relative, attribute.strip()


def _package_name(package_dir: Path) -> str:
    """目录 → 合成包名。这里是这条公式**唯一**的落点。

    "建"（`load_entrypoint`）和"删"（`forget`）都从这里取名字，所以公式怎么改都
    不会两边对不上——它们不可能各拿一份。
    """
    digest = hashlib.sha256(str(Path(package_dir).resolve()).encode("utf-8")).hexdigest()[:16]
    return _SYNTHETIC_PREFIX + digest


def _submodule_name(package_name: str, relative: Path) -> str:
    """文件路径 → 模块名：`sub/worker.py` → `包.sub.worker`。

    只取 `stem`（丢掉子目录）会让包里的相对 import 找错地方——`sub/worker.py` 里写
    `from . import config`，会去包根下找 `config` 而不是 `sub/config`。
    每一段必须是合法标识符：不合法的名字 `import` 机制根本找不到，宁可在加载前拒掉，
    也不要等包里的相对 import 神秘失败。
    """
    parts = relative.with_suffix("").parts
    for part in parts:
        if not part.isidentifier():
            raise RuntimeError(f"扩展入口的路径要能当模块名用（每段须是标识符）: {relative}")
    return ".".join((package_name, *parts))


def _ensure_package(package_name: str, root: Path) -> ModuleType:
    """把这个目录登记成一个合成包（已经在 `sys.modules` 里就直接用它）。

    有 `__init__.py` 就执行它——包里可能有"必须先跑一遍"的东西；没有就造一个空模块，
    但要塞上 `__path__`：**`__path__` 是相对 import 的支点**，没有它，包里的
    `from .graph import ...` 找不到同目录的兄弟文件。
    """
    cached = sys.modules.get(package_name)
    if cached is not None:
        return cached
    init_path = root / "__init__.py"
    if init_path.is_file():
        spec = _spec_for(init_path, package_name, search_root=root)
        module = importlib.util.module_from_spec(spec)
    else:
        spec = None
        module = ModuleType(package_name)
        module.__path__ = [str(root)]  # type: ignore[attr-defined]
    # 先登记、后执行：包里的模块互相相对 import（可能是环），执行到一半也得能被找到
    sys.modules[package_name] = module
    if spec is not None:
        loader = spec.loader
        assert loader is not None  # `_spec_for` 判过；这里只是把类型收窄
        loader.exec_module(module)
    return module


def _ensure_parents(module_name: str) -> None:
    """入口在子目录里时，把祖先包先导进来（`包.sub.worker` 要先有 `包.sub`）。

    交给 `importlib` 自己找：它照 `__path__` 走，子目录没有 `__init__.py` 也认
    （命名空间包）——那些模块也就自动落在"这个目录下"，失败时要一起撤得掉。
    """
    parts = module_name.split(".")
    for index in range(1, len(parts)):
        ancestor = ".".join(parts[:index])
        if ancestor not in sys.modules:
            importlib.import_module(ancestor)


def _load_file_module(module_name: str, source: Path) -> ModuleType:
    """按文件路径加载入口模块（已在 `sys.modules` 里就复用那份）。"""
    cached = sys.modules.get(module_name)
    if cached is not None:
        return cached
    spec = _spec_for(source, module_name)
    module = importlib.util.module_from_spec(spec)
    # 先登记、后执行：理由同 `_ensure_package`
    sys.modules[module_name] = module
    loader = spec.loader
    assert loader is not None  # `_spec_for` 判过；这里只是把类型收窄
    loader.exec_module(module)
    return module


def _spec_for(source: Path, module_name: str,
              search_root: Path | None = None) -> importlib.machinery.ModuleSpec:
    """给一个文件建加载规格。`search_root` 非空表示它是个包（要带 `__path__`）。

    建不出规格就是"这个文件没法当 Python 模块加载"，在这里当场拒掉——比等到
    `exec_module` 处抛一个看不懂的 `AttributeError` 强。
    """
    spec = importlib.util.spec_from_file_location(
        module_name,
        source,
        submodule_search_locations=[str(search_root)] if search_root is not None else None,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法为扩展模块建加载规格（没有可用的 loader）: {source}")
    return spec


def _belongs_to(module: object, root: Path) -> bool:
    """这个模块是不是从 `root` 这个目录里加载出来的？

    `__file__` 和 `__path__` 都要看：看 `__file__` 是主判据，而合成包**自己**恰恰
    可能没有它（没有 `__init__.py` 时那个空包，以及子目录的命名空间包）——只判
    `__file__` 会漏掉包本身，而漏掉它正是"下次加载命中残骸"那条路。

    查 `__dict__` 而不是属性访问：模块可以自己定义 `__getattr__`，`getattr` 会把它
    叫醒（那种模块本来就坏，但清理不该被它绊住）。`sys.modules` 里还可能蹲着 `None`
    （"禁掉这个 import"的老手法），所以拿不到 `__dict__` 就判成"不是我们的"。
    """
    namespace = getattr(module, "__dict__", None) or {}
    candidates: list[Any] = [namespace.get("__file__")]
    try:
        candidates.extend(namespace.get("__path__") or ())
    except Exception:  # noqa: BLE001
        # `__path__` 可以是惰性对象（命名空间包的 `_NamespacePath` 现算，且它要父包还
        # 在 `sys.modules` 里）——算不动就当它没给出线索，清理不该被它绊住。
        pass
    for candidate in candidates:
        if not candidate:
            continue
        try:
            resolved = Path(str(candidate)).resolve()
        except (OSError, ValueError):
            continue  # 不是能当路径看的东西（`__path__` 里可以是任意对象）
        if resolved == root or root in resolved.parents:
            return True
    return False


def _drop_from_dir(root: Path, keep: frozenset[str]) -> None:
    """把 `root` 这个目录留下的合成模块从 `sys.modules` 里摘掉，`keep` 里的除外。

    加载失败时传"这次调用之前就在"的那批名字：只撤这次新冒出来的，上一次加载成功
    留下的模块是别人的成果，动它会造出两份类对象（模块说明里那条 `isinstance` 的毛病）。

    **倒序遍历**（子模块在前、包在后）：命名空间包的 `__path__` 是**惰性算**的，它要
    父包还在 `sys.modules` 里才迭代得动——先摘父包，子包就在认领它时炸掉。先取一份
    list 快照，删的同时不改动正在遍历的那个字典。
    """
    package_name = _package_name(root)
    for name, module in reversed(list(sys.modules.items())):
        if name in keep:
            continue
        if name == package_name or _belongs_to(module, root):
            sys.modules.pop(name, None)
