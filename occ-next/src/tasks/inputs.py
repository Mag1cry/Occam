"""任务正文的读取：`task_ref` 指向工作区里的一个文件。

**它读的是工作区，不是宿主的任何东西**——路径先 `resolve()` 再卡一次边界，越界就拒。
和扩展入口那条一样：**这不是防攻击，是防手滑**——写错一格读到的就是另一个文件，
而它会以完全正常的样子跑起来。

## 读不到就让这次运行失败

旧代码是"把它交给 worker，读不到在读的那一刻炸"。那样的话 Task 已经是 `running`，
**日程看着像跑过了**（`OPEN_ISSUES.md` 里那条）。所以这里是起进程**之前**的一步：
读不出来就当场把这次运行收成 `failed`，理由是人话。

`task_ref` 为空时不读——不是每个执行者都要一份正文。

← 来自 assets/filesystem.py + assets/protocol.py
"""
from __future__ import annotations

from pathlib import Path


class InputMissing(RuntimeError):
    """正文读不到。**"没有这个文件"和"读不动"分开说**——人看到的下一步不一样。"""


def read(task_ref: str, *, root: Path | str) -> str:
    """读出正文。`task_ref` 是相对工作区的路径；为空就是没有正文。"""
    if not task_ref:
        return ""
    workspace = Path(root).resolve()
    target = (workspace / task_ref).resolve()
    if workspace not in target.parents and target != workspace:
        raise InputMissing(f"任务正文必须在工作区里: {task_ref}")
    if not target.is_file():
        raise InputMissing(f"找不到任务正文: {task_ref}")
    try:
        return target.read_text(encoding="utf-8")
    except OSError as exc:
        raise InputMissing(f"任务正文读不出来: {task_ref}: {exc}") from exc


#: 一份正文的体量上限。**正文是文本**——`read` 读的就是 utf-8，界面上那一格选的
#: 也该是一份文本。几十兆的东西从这儿进来只说明选错了文件，早点说比晚点说好。
MAX_BODY_BYTES = 1_000_000


def save(name: str, text: str, *, root: Path | str) -> str:
    """把一份正文**放进工作区**，返回它的相对路径（正斜杠）——给「选择文件」用。

    和 `read` 是同一棵树上的两个动作，规矩也一样：只落在工作区里。

    两条：

    - **只取文件名**，不取它带来的目录（浏览器给的就是个文件名，但"防手滑"这条
      在这棵树上是一贯的：路径拼错了会静默落到别处）。
    - **不覆盖**：重名就加序号（`报告.md` → `报告-2.md`）。用户点的是"选一份正文"，
      不是"覆盖那份正文"——而覆盖掉的可能是某条日程正指着的东西。

    出错一律 `ValueError`，**不是 `InputMissing`**：那是"读的时候找不到"（`read` 的事，
    调用方要据此把这次运行收成 failed），而这里全是"你给的东西不对"——接入面把它翻成
    400，原因原样带给用户。
    """
    body = str(text)
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError(
            f"这份正文太大了（{len(body.encode('utf-8'))} 字节，上限 {MAX_BODY_BYTES}）——"
            f"这里放的是文本，不是二进制")
    workspace = Path(root).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    clean = Path(str(name).replace("\\", "/")).name.strip()
    if not clean or clean.startswith("."):
        raise ValueError(f"这个文件名不能放进来: {name!r}")
    target = (workspace / clean).resolve()
    if workspace not in target.parents:
        raise ValueError(f"任务正文必须在工作区里: {name}")
    if target.exists():
        stem, suffix = target.stem, target.suffix
        for index in range(2, 1000):
            candidate = target.with_name(f"{stem}-{index}{suffix}")
            if not candidate.exists():
                target = candidate
                break
        else:
            raise ValueError(f"{clean} 这个名字已经有太多份了")
    target.write_text(body, encoding="utf-8")
    return target.relative_to(workspace).as_posix()
