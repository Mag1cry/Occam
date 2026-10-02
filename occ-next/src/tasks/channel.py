"""IPC 协议 + **包作者要照着写的契约**。

两条纪律之间的通道：Worker 在子进程里，不能直接调任何东西，它只能**说**。这份文件同时是
两端读的东西，也是**写执行者的人**唯一要读的那一页。

---

# 契约一：worker 入口长这样

```python
def worker_entry(connection, task_data, config_data, input_text,
                 database_path, resume_value=None) -> None:
    channel = WorkerChannel(connection, str(task_data["task_id"]))
    ...
```

六个位置参数。`resume_value` 是**上次停下来时留下的那个东西**（审批恢复时为 checkpoint
引用）；第一次跑是 `None`。

**`database_path` 是执行者自己的数据**（它的 checkpoint、它的结果），**不是控制库**——
Worker 从不打开控制库：它不认识 Task 表，也不该认识。那个文件由宿主指给你，
因为 `extensions/` 是用户会改动的 git 工作区，数据不该写在那儿。

# 契约二：能说的收尾只有三种

```python
channel.report(COMPLETED, {"checkpoint_ref": ..., "result_ref": ...})
channel.report(INTERRUPTED, {"checkpoint_ref": ...})     # ← 停下来等审批
channel.report(FAILED, {"reason": ...})
```

| 它说什么 | 那是什么意思 | Task 落到哪 |
| --- | --- | --- |
| `COMPLETED` | 正常退出，结果取**最后一次的输出** | `succeeded` |
| `INTERRUPTED` | **我停下来等审批** | `paused` |
| `FAILED` | 其他任何异常 | `failed` |

**左列是"它怎么说"，右列是"那意味着什么"。两套词，别混。**

**`INTERRUPTED` 不是"被中断了"这种泛泛的说法**——它的意思就是**停下来等审批**，而且
必须指名**是哪个工具**：内核那条 `Interrupt` 要求"有一个待审批对得上"
（`core/capability.py`），落到的 `paused` 正是"卡在等人批"那个状态。三处说的是同一件事。

**执行者不对错误分类**，它只说"我是怎么结束的"——那意味着什么终态是 Task 那一层的事。
所以这里只有三个词，没有第四个：多一个立刻要回答"那它落到哪个状态"。

# 契约三：要工具只有一条路

```python
result = channel.request_tool("weather.current", {"city": "上海"})
```

**这是 Worker 拿到工具的唯一办法**——不是靠纪律，是靠它在另一个进程里，手里除了这条
管道什么都没有。

**不用送参数哈希**：指纹由**宿主**从 `params` 现算（`core/capability.py` 规则一）——
你算的那个它不会信，送了也是白送。

**这条管道不做去重。** 同一个调用发两次就是**两次调用**，所以别在超时之后盲目重试：
你超时了，但你不知道对面做没做。**"这次重试安不安全"由工具自己的声明回答**
（`idempotency`），不由这条管道替你猜。

# 契约四：给模型的是 schema，不是句柄

```python
model.bind_tools([{"name": t.name, "description": t.description,
                   "parameters": t.input_schema} for t in tool_specs])
for call in response.tool_calls:            # 模型只会吐名字 + 参数
    result = channel.request_tool(call["name"], call["args"])
```

**为什么绑字典而不是绑一个转发用的 stub**：绑字典的话，**框架手里根本没有能跑的东西**——
`ToolNode` 要 `BaseTool`/callable，字典它执行不了。绑 stub 是**纪律**（stub 得一直是个好
stub）；绑字典是**结构**。跟"句柄从网关出去"是同一个动作。

**代价：`ToolNode` 平时做的四件事要自己补**——异常捕成 `ToolMessage`（不然一个工具错误
炸掉整个图）、`tool_call_id` 必填、`max_iterations`（不然模型可以无限调）、异步自己写一份。

---

## 消息形状

| 谁发的 | kind | 带什么 |
| --- | --- | --- |
| Worker | `tool_request` | `tool_id` · `params` |
| Worker | 三种 `*_report` | 见上 |
| 宿主 | `tool_result` | `ok` · `result` · `error` |
| 宿主 | `tool_approval_required` | 待审批的理由引用 |
| 宿主 | `tool_denied` | 拒绝的理由 |

`request_id` 是必须的：**回复和请求要能对上**。对不上就当成协议错误，不当成"结果是空的"。
它**只用来对账，不用来去重**——那是两个问题。

← 来自 control/channel.py（三个 report kind 与 worker 入口签名补成契约）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..gateway.function.ports import CallResult, denied, failed, needs_approval
from ..gateway.function.ports import allowed as call_allowed
from ..gateway.permission.decision import DENY, NEEDS_APPROVAL

#: 执行者能说的三种收尾。**封闭集合**——拼错了要在拼的地方知道。
COMPLETED = "completed_report"
INTERRUPTED = "interrupt_report"
FAILED = "failed_report"
REPORTS = (COMPLETED, INTERRUPTED, FAILED)

#: worker → 宿主：请求一次工具调用。
TOOL_REQUEST = "tool_request"

#: 宿主 → worker：三种答复。**它们和 `CallResult` 的三种判定一一对应。**
TOOL_RESULT = "tool_result"
TOOL_APPROVAL_REQUIRED = "tool_approval_required"
TOOL_DENIED = "tool_denied"

#: 兜底等待：管道断了/进程死了都靠它发现，所以它是**主路径**。
POLL_SECONDS = 0.5


@dataclass(frozen=True)
class Message:
    """管道上的一条。**纯数据**——它要过 `multiprocessing` 的序列化。"""

    kind: str
    request_id: str = ""
    payload: dict[str, Any] = field(default_factory=dict)


def tool_request(tool_id: str, params: dict[str, Any], request_id: str) -> Message:
    return Message(TOOL_REQUEST, request_id=request_id,
                   payload={"tool_id": tool_id, "params": dict(params or {})})


def reply_to(result: CallResult, request_id: str) -> Message:
    """把一个判定翻成 worker 看懂的那条消息。**三种判定，三种形状。**"""
    if result.decision == NEEDS_APPROVAL:
        return Message(TOOL_APPROVAL_REQUIRED, request_id=request_id,
                       payload={"reason_ref": result.reason_ref, "tool_id": result.tool_id})
    if result.decision == DENY:
        return Message(TOOL_DENIED, request_id=request_id,
                       payload={"error": result.error, "tool_id": result.tool_id})
    return Message(TOOL_RESULT, request_id=request_id,
                   payload={"ok": result.ok, "result": result.result,
                            "error": result.error, "tool_id": result.tool_id})


class Channel:
    """一条 IPC 上的说话方式。**两端读的是同一份契约**，所以形状在这里定。"""

    def __init__(self, connection: Any, task_id: str = "") -> None:
        self.connection = connection
        self.task_id = task_id

    def send(self, message: Message) -> None:
        self.connection.send(message)

    def pending(self) -> bool:
        """对面还有话说吗。**管道断了当"没有"**——那是"进程死了"的另一种说法，
        由调用方去判，不该在这里变成一个异常（Windows 上 pipe 断了抛的是 `BrokenPipeError`）。
        """
        try:
            return bool(self.connection.poll(0))
        except OSError:
            return False

    def receive(self, timeout: float | None = None) -> Message | None:
        """收一条。**超时返回 `None`**，不是抛——监听线程要能定期看一眼进程还活着没有。"""
        try:
            if not self.connection.poll(timeout):
                return None
            message = self.connection.recv()
        except (EOFError, OSError):
            # 对面没了。**当"没有消息"**——"进程死了"由监听线程另外发现，
            # 那是两件事，不该在这里混成一个异常。
            return None
        if isinstance(message, Message):
            return message
        # 不是我们说的话：**协议错误，不当成"结果是空的"**。
        return Message(str(getattr(message, "kind", "unknown")), payload={"raw": repr(message)})

    def close(self) -> None:
        try:
            self.connection.close()
        except OSError:
            pass


class WorkerChannel(Channel):
    """**包作者拿到的那一半。** 报告收尾 + 请求工具，就这两件事。"""

    def report(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        if kind not in REPORTS:
            raise ValueError(f"收尾只有三种: {' / '.join(REPORTS)}，收到: {kind}")
        self.send(Message(kind, payload=dict(payload or {})))

    def request_tool(self, tool_id: str, params: dict[str, Any] | None = None) -> CallResult:
        """要一次工具调用，**等宿主的答复**。

        这条路径上没有去重、没有重试：超时了就是"不知道对面做没做"。要重试的话，
        先看那个工具的 `idempotency` 声明。
        """
        request_id = f"call-{id(self)}-{_counter()}"
        self.send(tool_request(tool_id, params or {}, request_id))
        while True:
            message = self.receive(None)
            if message is None:
                return failed(tool_id, "通道断了，没等到工具答复")
            if message.request_id != request_id:
                continue                       # 不是自己那条：**跳过，继续等**
            return _as_result(message)


def _as_result(message: Message) -> CallResult:
    tool_id = str(message.payload.get("tool_id") or "")
    if message.kind == TOOL_APPROVAL_REQUIRED:
        return needs_approval(tool_id, str(message.payload.get("reason_ref") or ""))
    if message.kind == TOOL_DENIED:
        return denied(tool_id, str(message.payload.get("error") or "这次调用被拒绝了"))
    if message.kind == TOOL_RESULT:
        if message.payload.get("ok"):
            return call_allowed(tool_id, message.payload.get("result"))
        return failed(tool_id, str(message.payload.get("error") or "工具调用失败"))
    return failed(tool_id, f"看不懂的答复: {message.kind}")


_counter_value = 0


def _counter() -> int:
    global _counter_value
    _counter_value += 1
    return _counter_value
