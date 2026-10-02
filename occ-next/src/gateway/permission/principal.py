"""主体：**谁在请求**。外部人 / 执行者 / 系统。

它回答的是"这次请求是以谁的身份进来的"，不是"从哪个地址来的"——后者（local / lan /
external）归 `access/policy.py`，是判决的**输入**。

两者别混：一个执行者的工具请求**来自本机**（它就在宿主起的子进程里），但它不是
"外部人"。这一个字段决定的是**审计怎么写**，以及以后要不要按主体分权。

← 来自 gateway.py::AccessContext
"""
from __future__ import annotations

from dataclasses import dataclass

EXTERNAL = "external"     # 一个外部的使用者（界面、脚本）
EXECUTOR = "executor"     # 某个执行者（它在子进程里，经 IPC 过来）
SYSTEM = "system"         # 宿主自己（日程派发、启动对账）

KINDS = (EXTERNAL, EXECUTOR, SYSTEM)


@dataclass(frozen=True)
class Principal:
    kind: str
    executor_ref: str = ""
    detail: str = ""

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"主体只能是 {' / '.join(KINDS)}，收到: {self.kind}")

    @property
    def ref(self) -> str:
        """它叫什么——进审计那一格，也是日志里能搜的字符串。"""
        if self.kind == EXECUTOR:
            return f"executor:{self.executor_ref}"
        return self.kind


def external(detail: str = "") -> Principal:
    return Principal(EXTERNAL, detail=detail)


def of_executor(executor_ref: str) -> Principal:
    return Principal(EXECUTOR, executor_ref=executor_ref)


def system() -> Principal:
    return Principal(SYSTEM)
