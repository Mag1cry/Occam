"""Capability 原语：主管所有函数调用的审计记录。

它不判要不要批（那是 `gateway/function/`），也不知道有哪些工具（那是 `gateway/directory/`）。
它管的是**事实**：谁在什么时候请求了哪个动作、判定是什么、谁批的、最后做没做。

## 它没有自己的存储

审计记录由两样东西承载：

| 记什么 | 存在哪 |
| --- | --- |
| 待审批状态（卡在等人批） | **Task 上那几格**（`core/task.py`） |
| 请求了、准了、拒了、做了什么 | **事件链**（本文件产生） |

这不是省事，是如实的：**内核只需要存两样东西——Task 和事件**。Executor 只有一根引用
（没有存储），Capability 寄在 Task 的字段和事件链上。四原语里真正需要落库的只有两个。

## 五条命令、迁移与事件

| 命令 | 迁移 | 事件 |
| --- | --- | --- |
| `CallFunction` | 见下面「审批与兑现」 | `FUNCTION_APPROVAL_REQUESTED` / `FUNCTION_CALLED` |
| `Approve` | `pending_decision` → `approved` | `APPROVED` |
| `Deny` | `pending_decision` → `denied` | `DENIED` |
| `Interrupt` | → `paused` + checkpoint 引用 | `INTERRUPTED` |
| `Resume` | → `running` | `RESUMED` |

## `CallFunction` 带的是「判定」，不是「请你判」

| 它带什么 | 谁填的 |
| --- | --- |
| `tool_id` · `params` | Worker（它要调什么） |
| `decision` | **网关**——`allow` 或 `needs_approval`，就这两个 |
| `reason_ref` | 网关（要审批时，为什么） |

**`deny` 压根不进来。** 网关拒掉一个工具调用**不经过内核**——内核不知道有哪些工具，
也就不该收到"这个工具不许调"这种话。内核唯一会说出 `deny` 的地方是**兑现**：
那次审批的结论是拒绝，于是这个请求被拒。

**它也不管幂等**（`core/store.py` 里写了为什么）。认出"这不是新请求"的东西是**规则一那条
指纹**——指纹相同且已定案就是兑现，指纹不同才是新请求。命令缓存删掉之后，接住它的就是这个。
（"重试安不安全"是另一回事，那是**工具自己声明的**那一格：`idempotency`。）

---

# 审批与兑现

`pending` 的语义是：**有一个已经定案的判决，等这次调用来兑现。**

```text
pending_decision = "approved"  →  兑现成 allow（不再问用户第二遍）
pending_decision = "denied"    →  兑现成 deny
```

## 规则一：兑现必须按「请求指纹」，不能按工具名

**指纹 = `tool_id` + `params_hash`**，由**宿主**从请求现算
（`fingerprint()`）。worker 递过来的哈希不算数——那是它自己报的。

`target_ref` **已经删掉**。它原来是第三段，取值是 `task.task_ref`——而那是这个 Task
自己的正文路径，**同一个 Task 里每一调用都是同一个值**，所以在指纹里从来没有起到过
区分作用。留着它反而带出一个真 bug：`task_ref` 允许为空（`tasks/inputs.py` 头一行
是 `if not task_ref: return ""`），一旦为空，这个字段就是空串，而 `call_function`
的前置检查会因此把**每一次工具调用**都拒掉。所以那一栏不是"少一层保护"，是"一栏
本来就不干活、却会让合法请求过不去的东西"。要收窄工具能碰什么，该由网关的
`tools_from` / `tighten` 那一层说（`gateway/directory/capability_view.py`），
不由内核的一条字符串说。

旧代码只按 `tool_id` 比：

```python
if task.pending_tool_id == command.tool_id:          # ← 只比工具名
    if task.pending_decision == "approved":
        ... decision="allow" ...                      # ← 用的是**新请求**的参数
```

后果两条，第二条是真的漏洞：

| 场景 | 今天 | 应该是 |
| --- | --- | --- |
| 用户拒绝 A，Agent 改参数提 B | 被那次旧拒绝挡掉——**该重新问的没问** | 清掉陈旧 pending → 重新判 |
| 用户批准 A，Agent 提 B（同工具、不同参数） | **直接放行——审批绕过** | 清掉陈旧 pending → 重新判 |
| 用户拒绝/批准 A，Agent 提**别的工具** | `raise "Task 已有待处理的工具审批"` | 同上——已定案的审批不该挡路 |

「批准的是 A、执行的是 B」这条尤其要紧：它是那条"Agent 不能伪造批准"的保证**在同一个工具上失效**。

## 规则二：一个**已经定案**的 pending 不挡新请求

指纹不同，它就是**新请求**：清掉那格陈旧的 pending，然后走正常流程
（该审批就重新问用户，不该审批就直接放行）。

**但"已经定案"这个限定词是这条规则的半条命**——少了它，一个**还没批**的 pending
会被随便一个无关的新请求悄悄清掉，用户看到的"待审批"就自己消失了：

| pending 的状态 | 来了个指纹不同的请求 |
| --- | --- |
| 还没定案（`pending`） | **拒**——一次只等一件事批，说不清在等哪件就停不下来 |
| 已定案（`approved` / `denied`） | 清掉它，当新请求重新判 |

**清陈旧 pending 不多记一条事件**——它和这次的结果在**同一次 `commit` 里一起落**。
一次迁移一条事件，`state_version` 那条恒等式才守得住。

## 规则三：兑现也是一次判决，要记事件

兑现路径今天**没有 `append_event`**，但它改了 Task（清掉 pending 那几格 + `state_version += 1`）。

**新代码把这条堵死在两个方向：**

| 兑现的分支 | 处置 |
| --- | --- |
| 兑现成 **allow**（真的要去执行了） | 记 `FUNCTION_CALLED` + 清 pending，走 `commit()` —— 一次迁移一条事件 |
| 兑现成 **deny**（拒绝，什么都没发生） | **不改 Task、不记事件**，只回一个答案（`result_of()`）——拒绝没有改变任何东西，没有可记的事 |

于是 `state_version` 恒等于链上的条数（`core/store.py` 那条恒等式），
不需要"修一处、漏一处"。

---

## 为什么"Agent 不能伪造批准"这条性质没变

判决仍然发生在**宿主进程**里，由网关做；Worker 在另一个进程，碰不到网关。
守卫换了人（内核 → 网关），性质没变。

——但上面规则一那个漏洞提醒了一件事：**"判决由谁做"和"判决兑给了谁"是两件事**。
前者靠进程边界守住，后者靠指纹守住。缺一个，另一个就白做了。

← 来自 core/service.py 的 call_function / approve / deny / interrupt / resume + core/commands.py 的五条命令
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .errors import CommandRejected, Conflict
from .event import new_event, subject_of
from .store import CommandResult, TaskCommand, commit, result_of

if TYPE_CHECKING:  # 只为标注——`CoreStore` 的家在 kernel.py（并集住在那里）
    from .kernel import CoreStore

# 两个**迁移函数**从 task.py 借来（状态机必须在一处读完，`core/task.py`）。
# 起别名是因为 `resume` 这个名字本文件也要用——一个改状态，一个发命令。
from .task import Task, require_task
from .task import pause as task_pause
from .task import resume as task_resume

#: 网关能给的判定。**`deny` 不在里面**——拒绝不经过内核。
DECISIONS = frozenset({"allow", "needs_approval"})


@dataclass(frozen=True)
class CallFunction(TaskCommand):
    """网关**已经判完**了，来说一声。

    `params` 带 `repr=False`：**参数永不落库、不入日志**——链上只留一个哈希
    （`payload["params_hash"]`）。这一格是隐私性质，不是优化。
    """

    tool_id: str = ""
    decision: str = ""
    reason_ref: str = ""
    params: dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class Approve(TaskCommand):
    decision_ref: str = ""


@dataclass(frozen=True)
class Deny(TaskCommand):
    decision_ref: str = ""


@dataclass(frozen=True)
class Interrupt(TaskCommand):
    tool_id: str = ""
    checkpoint_ref: str = ""
    reason_ref: str = ""


@dataclass(frozen=True)
class Resume(TaskCommand):
    checkpoint_ref: str = ""


def params_hash(params: dict[str, Any]) -> str:
    """参数的规范化摘要：键排序、分隔符固定，所以同样的参数永远同一个哈希。"""
    raw = json.dumps(params or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def fingerprint(tool_id: str, params: dict[str, Any]) -> str:
    """**一次请求的身份**。规则一靠它，不靠工具名。

    两段拼起来：调哪个工具、带什么参数。任何一段变了就是**另一个请求**——
    批准过的那次不覆盖它。

    （第三段 `target_ref` 已删，理由见模块说明：它取值恒等于 Task 自己的正文路径，
    同一个 Task 里不变，区分不了任何两次调用，还会在正文为空时误伤全部调用。）
    """
    return f"{tool_id}|{params_hash(params)}"


def call_function(store: CoreStore, command: CallFunction) -> CommandResult:
    if not command.tool_id:
        raise CommandRejected("tool_id 不能为空")
    if command.decision not in DECISIONS:
        raise CommandRejected("判定只能是 allow / needs_approval——拒绝不经过内核")

    with store.transaction() as uow:
        task = require_task(uow, command.task_id)
        if task.status != "running":
            raise CommandRejected(f"Task 状态 {task.status} 不能调用工具")

        digest = params_hash(command.params)
        mark = fingerprint(command.tool_id, command.params)

        # ── 规则一：指纹对上了，这条请求就是那次已经定案的判决要等的那个
        if task.has_pending and task.pending_fingerprint == mark:
            if task.pending_decision == "denied":
                # 兑现成 deny：**什么都没发生**，所以不改 Task、不记事件（规则三）
                return result_of(command, task=task, decision="deny", error="工具调用已被拒绝")
            if task.pending_decision == "approved":
                task.clear_pending()
                return commit(uow, command, task, decision="allow",
                              event=_called(task, command.tool_id, digest),
                              data={"decision_source": "approved"})
            # 还没定案：同一次请求又来了，把同一个答复再给它（不改状态，所以不记事件）
            return result_of(command, task=task, decision="needs_approval",
                             data={"reason_ref": task.pending_reason_ref,
                                   "tool_id": task.pending_tool_id})

        # ── 规则二：指纹不同（或压根没有 pending）→ 这是**新请求**
        if task.has_pending and task.pending_decision == "pending":
            # **还没定案的那一件挡路。** 一次只等一件事批——说得清"在等哪件"
            # 才停得下来（`interrupt` 也是这么要求的）。
            raise CommandRejected("Task 已有待处理的工具审批")
        # 已经定案的不挡新请求：清掉那格陈旧的，它和下面那次 commit 一起落，
        # 所以不多记一条事件。
        task.clear_pending()

        if command.decision == "needs_approval":
            if not command.reason_ref:
                raise CommandRejected("需要审批的工具必须提供 reason_ref")
            task.pending_tool_id = command.tool_id
            task.pending_reason_ref = command.reason_ref
            task.pending_decision = "pending"
            task.pending_fingerprint = mark
            event = new_event("FUNCTION_APPROVAL_REQUESTED", subject_of(task.task_id),
                              task_id=task.task_id, tool_id=command.tool_id,
                              payload={"reason_ref": command.reason_ref,
                                       "params_hash": digest})
            return commit(uow, command, task, decision="needs_approval", event=event,
                          data={"reason_ref": command.reason_ref, "tool_id": command.tool_id})

        return commit(uow, command, task, decision="allow",
                      event=_called(task, command.tool_id, digest),
                      data={"decision_source": "declared"})


def interrupt(store: CoreStore, command: Interrupt) -> CommandResult:
    """`running` → `paused`，停在那个 checkpoint 上等人批。

    **必须指名是哪个工具**：一次只等一件事批，说不清是哪件就不该停。
    """
    if not command.tool_id or not command.checkpoint_ref:
        raise CommandRejected("interrupt 必须提供 tool_id 和 checkpoint_ref")
    with store.transaction() as uow:
        task = require_task(uow, command.task_id)
        if task.status != "running" or task.pending_tool_id != command.tool_id:
            raise CommandRejected("Task 没有对应的待审批工具")
        task.checkpoint_ref = command.checkpoint_ref or task.checkpoint_ref
        event = new_event("INTERRUPTED", subject_of(task.task_id), task_id=task.task_id,
                          tool_id=command.tool_id, external_ref=command.checkpoint_ref,
                          payload={"reason_ref": command.reason_ref or task.pending_reason_ref})
        return task_pause(uow, command, task, event=event)


def approve(store: CoreStore, command: Approve) -> CommandResult:
    return _decide(store, command, approved=True)


def deny(store: CoreStore, command: Deny) -> CommandResult:
    return _decide(store, command, approved=False)


def _decide(store: CoreStore, command: Approve | Deny, *, approved: bool) -> CommandResult:
    if not command.decision_ref:
        raise CommandRejected("审批命令必须提供 decision_ref")
    with store.transaction() as uow:
        task = require_task(uow, command.task_id)
        if task.status != "paused" or not task.has_pending:
            raise CommandRejected("Task 没有待处理的审批")
        desired = "approved" if approved else "denied"
        if task.pending_decision not in {"pending", desired}:
            raise CommandRejected("审批状态不允许重复或反向修改")
        if task.pending_decision == desired:
            # 同向重复 = 空转。**没有状态变化，就没有事件**——这是它唯一正当的用处。
            return result_of(command, task=task, decision=desired)
        task.pending_decision = desired
        event = new_event("APPROVED" if approved else "DENIED", subject_of(task.task_id),
                          task_id=task.task_id, tool_id=task.pending_tool_id,
                          external_ref=command.decision_ref)
        return commit(uow, command, task, event=event, decision=desired)


def resume(store: CoreStore, command: Resume) -> CommandResult:
    """`paused` → `running`。**checkpoint 必须与 Task 上那把完全相等**——
    resume 是"从那一把继续"，不是"跳到另一把"。
    """
    if not command.checkpoint_ref:
        raise CommandRejected("resume 必须提供 checkpoint_ref")
    with store.transaction() as uow:
        task = require_task(uow, command.task_id)
        if task.status != "paused" or task.pending_decision not in {"approved", "denied"}:
            raise CommandRejected("Task 没有可恢复的审批结果")
        if not task.checkpoint_ref:
            raise CommandRejected("Task 没有可恢复的 checkpoint_ref")
        if command.checkpoint_ref != task.checkpoint_ref:
            raise Conflict("resume 的 checkpoint_ref 与 Task 当前引用不一致")
        event = new_event("RESUMED", subject_of(task.task_id), task_id=task.task_id,
                          external_ref=command.checkpoint_ref,
                          payload={"checkpoint_ref": command.checkpoint_ref})
        return task_resume(uow, command, task, event=event)


def _called(task: Task, tool_id: str, digest: str):
    """`FUNCTION_CALLED` 的模具——两个地方要记它（直接放行、兑现 allow），
    只有这一处拼 payload。"""
    return new_event("FUNCTION_CALLED", subject_of(task.task_id), task_id=task.task_id,
                     tool_id=tool_id, payload={"params_hash": digest})
