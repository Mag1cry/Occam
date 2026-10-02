"""**一份输出**：要送到外面去的那件事，以及它从哪条事实派生。

## 它是投影，不是第五份事实

审批在不在、结果是什么，答案都在内核里（`Task` 的那几格 + 事件链）。这里只把它们
**翻译成外面看得懂的一句话 + 几个可做的动作**。所以这整个模块**没有存储、没有状态**：
同一个 Task 读两遍，派生出的是同一份输出。`web/snapshot.py` 那条"投影不是第五份
数据"，在这儿是同一句话。

## 谁派生它

两条入口，其实是同一件事：

- `standing(kernel)` —— **现在悬着**的那些（给快照用：前端读一次快照就知道有什么
  在等人拍板）；
- `from_fact(task, event)` —— 刚刚落链的那条事实派生出什么（给事件驱动用：装配期
  递给内核的那只耳朵听见一条，就问一句"这要不要送出去"）。

## 今天只有一种来源

**审批。** 结果那一格（`kind="result"`）形状留着，但今天没有生产者：任务跑完了，
事实流本身就会说话（状态变了，界面自己会亮）——不需要再弹一次。等真有"要把结果送到
外面"的场景（比如飞书推一张完成卡片），它是同一张表里的第三种 `kind`。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: 输出的三种身份。**不是三种机制**——出去的是同一份描述，回来的是同一条命令。
APPROVAL = "approval"
RESULT = "result"
REQUEST = "request"          # 还没人产出它：申请 = 需要人拍板的事，见 README


@dataclass(frozen=True)
class OutputAction:
    """对它**能做的动作**。

    `command` 是"这一下会变成哪条中枢命令"——`open` 没有，因为它不改任何东西。
    **回来的时候走的还是命令面**（`approve`/`deny`），这一步只是把"外面那一下"
    翻译成命令名；证据（谁在哪点的）由回来那条路自己填。
    """

    ref: str                 # approve | deny | open
    label: str               # 批准 / 拒绝 / 打开
    command: str = ""


@dataclass(frozen=True)
class Output:
    """一件要送到外面去的事。

    `ref` 是它的身份：**同一个单位只有一个**（`task:<id>:approval`），所以外面
    （前端、飞书）能拿它去重——重连、重启、刷新都不会把它当成第二件事。
    """

    ref: str
    kind: str
    target_ref: str          # 指向哪件东西（task:<id>）
    title: str
    summary: str             # 给人看的摘要——**不是事实本身**（不搬 Task 的字段）
    actions: tuple[OutputAction, ...] = ()
    expires_at: str = ""


#: 审批的两个动作。**同一条命令**，外面从哪儿点进来的只影响证据那一格。
_APPROVAL_ACTIONS = (
    OutputAction(ref="approve", label="批准", command="approve"),
    OutputAction(ref="deny", label="拒绝", command="deny"),
)


def for_task(task: Any, *, kind: str = APPROVAL) -> Output | None:
    """一个 Task **现在**要不要送出去。不要就答 `None`。

    ## 什么时候算"悬着"

    | 条件 | 为什么 |
    | --- | --- |
    | `has_pending` | 有一件工具调用在等人拍板 |
    | `pending_decision == "pending"` | **还没定案**。批过/拒过的不再送——那不是待办，是历史 |
    | `status == "paused"` | **已经停下来了**。停之前送出去，外面点"批准"会被内核拒（`Task 没有待处理的审批`）——送一件点了会失败的事，比不送糟 |

    第三条正是 `INTERRUPTED` 那条事实存在的意义：它是"停稳了"的落点，
    所以事件驱动那边听的是它，不是 `FUNCTION_APPROVAL_REQUESTED`。

    ## 摘要里写什么

    **只写内核说过的话**：要调哪个工具、为什么。`FUNCTION_APPROVAL_REQUESTED` 的
    `reason_ref` 就是那句"为什么"（`approval:weather.current`）。这里不拼
    "模型打算……" —— 那不是内核的事实，是包自己的叙述，要写也由包写成 `reason_ref`。
    """
    if kind != APPROVAL:
        return None
    if not getattr(task, "has_pending", False):
        return None
    if task.pending_decision != "pending" or task.status != "paused":
        return None
    tool_id = str(task.pending_tool_id or "")
    reason = str(task.pending_reason_ref or "")
    return Output(
        ref=f"task:{task.task_id}:approval",
        kind=APPROVAL,
        target_ref=f"task:{task.task_id}",
        title=task.summary or task.task_id,
        summary=f"要调用 `{tool_id}`" + (f"（{reason}）" if reason else ""),
        actions=_APPROVAL_ACTIONS,
    )


def standing(kernel: Any) -> list[Output]:
    """**现在悬着的**那些输出。给快照用：前端读一次就知道有什么在等人拍板。

    无状态、可随时重算——所以它不需要"送过没有"那本账（那本账归各条**路径**，
    见 `paths.py`）。
    """
    found: list[Output] = []
    for task in kernel.list_tasks():
        one = for_task(task)
        if one is not None:
            found.append(one)
    return found


def from_fact(kernel: Any, event: Any) -> Output | None:
    """**刚落的这条事实**要不要送出去。

    只有一条事实会产出输出：`INTERRUPTED`（Task 停下来等审批的那一刻）。
    其余的事实要么不是这件事（`TASK_CREATED` / `FUNCTION_CALLED`），要么是它的
    后续（`APPROVED` / `DENIED` —— 那件待办已经没了，不该再送）。

    听 `INTERRUPTED` 而不是 `FUNCTION_APPROVAL_REQUESTED`：**后者发生的那一刻
    Task 还没停**，那时候送出去，外面点"批准"会被内核拒。
    """
    if getattr(event, "event_type", "") != "INTERRUPTED":
        return None
    task_id = str(getattr(event, "task_id", "") or "")
    if not task_id:
        return None
    try:
        task = kernel.get_task(task_id)
    except Exception:                    # noqa: BLE001 — 读不到就当没有这件事
        return None
    return for_task(task)
