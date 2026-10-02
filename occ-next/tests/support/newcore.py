"""新树功能测试的共用说法。**它不测什么**——只是让测试读起来像在说事。

这些函数是**站在使用者位置上**写的：建一个委托、请求调一次工具、停下来等人批。
判定（`allow` / `needs_approval`）本该由网关给，测试里我们直接扮演网关——
因为它判完之后内核收到的就是这几个字。
"""
from __future__ import annotations

from src.core.capability import Approve, CallFunction, Deny, Interrupt, Resume
from src.core.task import Complete, CreateTask, Fail

#: 一个"要人批"的工具、一个"不用批"的工具，测试里反复用。
TOOL = "workspace.read_text"
PARAMS = {"path": "hello.txt"}


def start(kernel, executor: str = "weather.collect", summary: str = "做一件事") -> str:
    """建一个委托，回它的 id。"""
    return kernel.create_task(CreateTask(summary=summary, executor_ref=executor)).task_id


def ask_for_tool(kernel, task_id: str, *, decision: str = "needs_approval",
                 tool: str = TOOL,
                 params: dict | None = None, reason: str = "规则要求"):
    """请求调一次工具。`decision` 是**网关那一层的结论**。"""
    return kernel.call_function(CallFunction(
        task_id=task_id, tool_id=tool, decision=decision,
        reason_ref=reason, params=PARAMS if params is None else params))


def stop_for_approval(kernel, task_id: str, *, tool: str = TOOL, checkpoint: str = "cp-1"):
    """执行者停在那个断点上，等人批。"""
    return kernel.interrupt(Interrupt(task_id=task_id, tool_id=tool,
                                      checkpoint_ref=checkpoint))


def approve(kernel, task_id: str, *, decision_ref: str = "yes"):
    return kernel.approve(Approve(task_id=task_id, decision_ref=decision_ref))


def deny(kernel, task_id: str, *, decision_ref: str = "no"):
    return kernel.deny(Deny(task_id=task_id, decision_ref=decision_ref))


def resume(kernel, task_id: str, *, checkpoint: str = "cp-1"):
    return kernel.resume(Resume(task_id=task_id, checkpoint_ref=checkpoint))


def finish(kernel, task_id: str, *, result_ref: str = "res://结果"):
    return kernel.complete_task(Complete(task_id=task_id, result_ref=result_ref))


def fail(kernel, task_id: str, *, reason: str = "炸了"):
    return kernel.fail_task(Fail(task_id=task_id, reason=reason))


def history(kernel, task_id: str) -> list[str]:
    """这个委托的历史——一串事件类型，按发生的顺序。"""
    return [event.event_type for event in kernel.events(task_id)]


def status(kernel, task_id: str) -> str:
    return kernel.get_task(task_id).status
