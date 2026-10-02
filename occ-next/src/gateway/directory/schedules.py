"""**日程列表**：有哪些日程、什么时候跑、跑到哪、开不开。

另外两个列表装的是**供给**（能调什么 / 谁负责推）。日程不是供给——它是**触发**：
到点了建一个 Task。**但它照样要登记，因为前端要渲染它。**

"列表是前端渲染的唯一依据"这条不能有例外：日程要是没有自己的列表，前端就得另编一套
"日程"的概念，那正是"同一件事两处说"，而它会漂移（"暂停跨不过重启"就是这么来的）。

## 开关在声明里，不在这里

`enabled` 是磁盘上那份文件里的一行（`extensions/_schedules/<name>.yaml`）。
这个列表只是**这一次加载读到的样子**——没有 `set_enabled` 这种写法，
改开关就是改那个文件（`extensions/writer.py`），然后重读。

## 它是轮询的输入，不是闹钟

这里存的是"什么时候**该**跑"。`tasks/scheduler.py` 每 30 秒醒一次拿它对照当前时间——
算"下一次该在几分几秒醒"要维护一堆状态，而 occurrence 幂等让轮询本来就是安全的。

← 新建（日程从扩展包清单里搬出来，独立成文件）
"""
from __future__ import annotations

from ...extensions.manifest import Schedule


class ScheduleDirectory:
    def __init__(self) -> None:
        self._items: tuple[Schedule, ...] = ()

    def replace(self, items: tuple[Schedule, ...]) -> None:
        self._items = tuple(items)

    def all(self) -> tuple[Schedule, ...]:
        return self._items

    def get(self, name: str) -> Schedule | None:
        for item in self._items:
            if item.name == name:
                return item
        return None

    def enabled(self) -> tuple[Schedule, ...]:
        """要派发的那些。**关着的仍然在 `all()` 里**——前端照常渲染它。"""
        return tuple(item for item in self._items if item.enabled)
