"""把「启用/停用」变成实际的加载、注册、启停与回滚。

## 改开关：尽力当场生效

改一行 `enabled` 之后，这个包要真的开始/停止。五件事，顺序固定：

```text
① 重扫 extensions/（包 + _schedules + _providers）
② 加载所有开着的（含禁用的→它在结果里，只是没有工具）
③ 注册进那四个列表
④ 失败就回滚刚交出去的那份
⑤ 记一次失败，但**不改写用户的选择**（清单保持 true，诊断说"它起不来"）
```

**它是唯一会"倒带"的地方。** 别的文件要么成功要么失败，它失败时要把刚注册的东西
撤掉——否则会留下一个"半个包"：名字占着、列表里有、但点下去调不通。

**不做增量，每次全量重来。** 增量要处理"改了一半"的各种中间态（文件删了但还在跑、
清单改了但代码没改），而全量只有一条路径。它是运维动作，不是常态，慢一点没关系。

## 改 `.py` 源码要重启

`sys.modules` 里的模块改不了，而这个文件**不驱逐它们**了——为"改代码即时生效"维护
一套全目录卸载，换来的只有那一格，而重启解决它。所以：**开关即时生效，源码改动重启。**

（同一秒内、大小不变的文件会被 `.pyc` 判成没过期，读到旧字节码；那也是重启能解的。）

**正在跑的 Task 不受影响**：它们手里是 stub，**下次调用时工具不在了就会被拒绝**，
不会崩。

## 谁去登记？**不是它。**

`extensions/` **不拥有那四个列表**（`extensions/README.md` 的头一条边界）。所以这里
不 import 网关，而是收一个**写入面**：装配期把网关接上去，测试里可以接一个记账的假实现。

**每一次交给它的是"完整的现在"**，不是"这次改了哪几条"。于是**回滚就是把上一次那份
再交一遍**——不用维护"我刚加了什么"那份账，而那份账正是会跟真实状态漂移的东西。

## 边界

- **不改写用户的开关。** 加载失败是"它现在起不来"，不是"用户想关它"——两回事，
  混起来就会偷偷改掉用户的选择。**这个文件一行写操作都没有**（写是 `writer.py` 的事）。
- **不驱逐任何模块。** 那是 `sys.modules` 的事，而它已经不做了（见上）。

← 来自 composition/activator.py
"""
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .diagnostics import Diagnostic
from .loader import ExtensionLoader, Loaded
from .mcp_client import DEFAULT_TIMEOUT


class Registrar(Protocol):
    """**四个列表的写入面。**

    实现它的通常是网关（`gateway/directory/`），但这里只知道这么一件事：
    **给它一份完整的现在。** 于是回滚只是"再交一遍上一次那份"。
    """

    def replace(self, loaded: Loaded) -> None: ...


class HotLoader:
    """把声明里的一行改动，变成真的加载、注册、启停。"""

    def __init__(self, root: Path, registrar: Registrar, *,
                 timeout: float = DEFAULT_TIMEOUT) -> None:
        self.root = Path(root)
        self.registrar = registrar
        self.loader = ExtensionLoader(self.root, timeout=timeout)
        self._current = Loaded()

    @property
    def current(self) -> Loaded:
        """**现在的样子。** 它就是上一次交出去的那一份。"""
        return self._current

    def refresh(self) -> Loaded:
        """按**磁盘上现在的声明**重新算一遍，然后交出去。**改开关走这条。**"""
        return self._publish()

    # ── 五步

    def _publish(self) -> Loaded:
        """① 重扫 → ② 加载 → ③ 注册 → ④ 失败回滚 → ⑤ 诊断留着。

        **顺序是有讲究的**：先把新的建起来、再收旧的（`previous.close()` 在注册成功
        之后）。反过来先说收旧的、新的一旦建不起来，就会有一段时间**什么都没有**。
        """
        previous = self._current
        loaded = self.loader.load(self.loader.scan())

        try:
            self.registrar.replace(loaded)
        except Exception:
            # **④ 回滚**：交出去的那份错了一半，就把上一次那份再交一遍，
            # 并把这次刚建起来的供给全收掉（不收就是泄漏的单例）。
            loaded.close()
            self.registrar.replace(previous)
            raise

        previous.close()
        self._current = loaded
        return loaded

    # ── 诊断

    @property
    def diagnostics(self) -> tuple[Diagnostic, ...]:
        """当前这一批的失败记录。

        **它不落库**（ADR-028），所以重启之后就没了——那条记在 `OPEN_ISSUES.md`。
        它是"这一次扫描/加载为什么有东西没起来"的唯一说法。

        每一条上的 `imported` 回答的是**下一步怎么办**：没进宿主进程的，改完重试就行；
        进了的，"禁用"卸不干净，得**重新识别**。
        """
        return self._current.diagnostics
