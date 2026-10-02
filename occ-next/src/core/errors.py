"""内核的错误：稳定的那一批。

四个原语抛的是同一批错，所以它们住在这里——不属于任何一个原语，
但每个原语都要用（`core/README.md` 说"共用只有两个文件"，这是其中一个）。

**`InvariantViolation` 已删**：全仓零引用。它当年是想当"内部不变量被破坏"的兜底，
但真正的那条不变量（**改状态必记事件**）今天由**签名**保证——`commit()` 要求你
同时给出事件，写不出"改了忘了记"的代码，也就不需要一个没人抛的异常来兜底。
"""


class OCCError(Exception):
    """OCC 预期内错误的基类。路由层按它分成 4xx / 5xx。"""


class CommandRejected(OCCError):
    """命令违反了公开的控制契约——**前置条件不满足**。

    这一条承担了"重复提交"的拒绝：`Complete` 只能从 `running` 出发、`Approve`
    只能从 `paused` 出发，所以重放会被它挡下来（`core/store.py`）。
    """


class NotFound(OCCError):
    """引用的 Task 不存在。**工具和执行的引用不在这里判**——那是网关的事。"""


class Conflict(OCCError):
    """状态冲突：checkpoint 对不上、参数摘要对不上。"""


class EventStoreCorrupted(OCCError):
    """事件存储里有无法信任的内部记录。发现即停止追加——不在不可信的历史上
    制造新的控制事实（`storage/README.md` 的两种坏法）。"""
