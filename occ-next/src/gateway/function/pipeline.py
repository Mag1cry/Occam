"""一次工具调用：**判 → 定性 → 记账 → 执行**。顺序固定，且只做一遍。

```text
① 判      judge([工具被声明过, 这个执行者被允许用它], default="deny")
              ↓ 拒绝 → 回给 Worker，**不经过内核**（内核不知道有哪些工具）
② 定性    显性声明的审批要求 → allow 或 needs_approval
③ 记账    告诉内核"这次调用，判定是 X" → 内核记一笔
              ↓ 内核说 allow 才继续
④ 执行    providers
```

**这是三层里唯一知道"有哪些工具"的地方**，所以也只有它能判。

## 内核的答复决定要不要执行

③ 的返回值不是"记完了"，而是**这次调用最终算哪种**：

| 内核说 | 意思是 | 这一层 |
| --- | --- | --- |
| `allow` | 允许了（刚判的，或**兑现**了一次已批准的审批） | 去执行 |
| `needs_approval` | 记下了，等人批 | 原样把理由回给 worker（它会进 interrupt） |
| `deny` | 兑现了一次**已拒绝**的审批 | 回拒绝，不执行 |

于是"审批完了要执行"不需要第二个判定点——**兑现走的就是这条路**：worker 从
checkpoint 起来，把同一个请求再发一遍，指纹对上了，内核说 `allow`。

## 内核抛错也要回一条答复

状态不对（Task 不在 running、已经有待审批的）会被内核拒。**那不能变成"监听线程静默
退出"**——worker 那边在等一个答复，等不到就是卡死。所以这里接住它，翻成一句话回过去。

## 边界

- **不拥有进程**、**不读存储**、**不碰 prompt / 模型 / 消息**——它只认"工具 + 参数 + 判定"。
- **判决只做一遍**：同一个调用不许出现第二个判定的地方。

## 已知缺口

工具调用在**网关这边**没有执行记录（`audit.py` 记的是命令，而它不走门面），结果只活在
worker 的 checkpoint 里。④ 之后该补一条（tool_id、参数摘要、ok/err、耗时）——它和内核的
`FUNCTION_CALLED` 是两条不同的记录、两个不同的来源（ADR-037）。

← 来自 gateway.py::accept_core_grant/invoke + control/task_controller.py::_handle_tool
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ...core.capability import CallFunction
from ...core.errors import CommandRejected
from ...core.kernel import Kernel
from ..directory.capability_view import CapabilityView
from ..permission.decision import ALLOW, NEEDS_APPROVAL
from ..permission.judge import judge
from ..permission.judge import classify as grade
from .ports import CallResult, ToolChannel, allowed, denied, failed, needs_approval
from .providers import ToolMissing, ToolSupplies


@dataclass(frozen=True)
class ToolRequest:
    """worker 要调一次工具。**参数不进日志**（`repr=False`）。"""

    task_id: str
    executor_ref: str
    tool_id: str
    params: dict[str, Any] = field(default_factory=dict, repr=False)
    request_id: str = ""


class ToolPipeline(ToolChannel):
    def __init__(self, *, kernel: Kernel, view: CapabilityView,
                 supplies: ToolSupplies) -> None:
        self.kernel = kernel
        self.view = view
        self.supplies = supplies

    def call(self, request: ToolRequest) -> CallResult:      # type: ignore[override]
        # ① 判：两条都是"必须成立"，默认拒绝。
        decision = judge([
            self.view.declared(request.tool_id),
            self.view.allows(request.executor_ref, request.tool_id),
        ])
        # 上面两行就是那张判决表：**工具被声明过 · 这个执行者被允许用它**。
        if not decision.allowed:
            # 不经过内核：它不知道有哪些工具，也就不该收到"这个工具不许调"这种话。
            return denied(request.tool_id, decision.reason)

        # ② 定性：能不能调是一件事，要不要人批是另一件事。
        graded = grade(approval_required=self.view.approval_for(
            request.executor_ref, request.tool_id))

        # ③ 记账：内核收到的是**判定**，不是"请你判一下"。
        try:
            outcome = self.kernel.call_function(CallFunction(
                task_id=request.task_id,
                tool_id=request.tool_id,
                decision=graded.outcome,
                reason_ref=f"approval:{request.tool_id}",
                params=request.params,
            ))
        except CommandRejected as exc:
            return denied(request.tool_id, str(exc))

        if outcome.decision == NEEDS_APPROVAL:
            return needs_approval(request.tool_id,
                                  str(outcome.data.get("reason_ref") or f"approval:{request.tool_id}"))
        if outcome.decision != ALLOW:
            return denied(request.tool_id, outcome.error or "这次调用被拒绝了")

        # ④ 执行。
        try:
            value = self.supplies.invoke(request.tool_id, request.params)
        except ToolMissing as exc:
            return failed(request.tool_id, str(exc))
        except Exception as exc:                            # noqa: BLE001 — 工具自己失败了
            return failed(request.tool_id, f"{type(exc).__name__}: {exc}")
        return allowed(request.tool_id, value)
